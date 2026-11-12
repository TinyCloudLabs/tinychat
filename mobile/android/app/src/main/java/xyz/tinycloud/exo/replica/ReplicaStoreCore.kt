package xyz.tinycloud.exo.replica

import java.io.File
import java.nio.ByteBuffer
import java.security.GeneralSecurityException
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** A bridge error; [code] is one of the contract's codes (NOT_OPEN, STORAGE_BUDGET, STORAGE_FULL, CORRUPT, INVALID_ARGUMENT, IO). */
class ReplicaStoreException(val code: String, message: String) : Exception(message)

/** One `write` op as received; validated inside the transaction so a bad op rolls back the whole batch. */
data class WriteOp(val op: String?, val store: String?, val key: String? = null, val value: String? = null)

data class OpenResult(val schemaVersion: Int, val created: Boolean)
data class Estimate(val usedBytes: Long, val freeBytes: Long?)

/**
 * TC-2862 native replica storage: one encrypted SQLite file per account (see the S1 contract). Keys are stored as
 * HMACs, values sealed with AES-256-GCM together with their key; both keys derive from a per-account secret held by
 * [secrets]. One account is open at a time; every method is serialized.
 */
class ReplicaStoreCore(
    private val dir: File,
    private val secrets: SecretStore,
    /** Opens [File] keyed with the raw 32-byte SQLCipher key; throws [ReplicaDbUnreadable] if the key can't open it. */
    private val openDb: (File, ByteArray) -> ReplicaDb,
    private val freeBytes: () -> Long?,
) {
    companion object {
        const val SCHEMA_VERSION = 1
        const val MARKER = ".installed"
        private val SUFFIXES = listOf("", "-wal", "-shm", "-journal")
        private const val ZERO: Byte = 0
        private val random = SecureRandom()

        fun accountId(account: String): String =
            MessageDigest.getInstance("SHA-256").digest(account.toByteArray()).joinToString("") { "%02x".format(it) }

        fun hmac(key: ByteArray, data: ByteArray): ByteArray =
            Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }.doFinal(data)

        /** RFC 5869 HKDF-SHA256; an empty [salt] means HashLen zero bytes. */
        fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
            val prk = hmac(if (salt.isEmpty()) ByteArray(32) else salt, ikm)
            val out = ByteArray(length)
            var t = ByteArray(0)
            var done = 0
            var counter = 1
            while (done < length) {
                t = hmac(prk, t + info + byteArrayOf(counter++.toByte()))
                val n = minOf(t.size, length - done)
                System.arraycopy(t, 0, out, done, n)
                done += n
            }
            return out
        }

        /** SQLCipher's raw page key (D-S5), the same HKDF derivation as iOS. */
        fun databaseKey(secret: ByteArray): ByteArray = hkdf(secret, ByteArray(0), "tc-replica/v1/db".toByteArray(), 32)

        fun compareUtf8(a: String, b: String): Int {
            val x = a.toByteArray()
            val y = b.toByteArray()
            for (i in 0 until minOf(x.size, y.size)) {
                val d = (x[i].toInt() and 0xff) - (y[i].toInt() and 0xff)
                if (d != 0) return d
            }
            return x.size - y.size
        }
    }

    private class Session(val account: String, val id: String, val db: ReplicaDb, val encKey: ByteArray, val macKey: ByteArray, var maxBytes: Long?)

    private var session: Session? = null

    private fun dbFile(id: String) = File(dir, "$id.sqlite")

    private fun ensureMarker() {
        val marker = File(dir, MARKER)
        if (marker.exists()) return
        if (!dir.isDirectory && !dir.mkdirs()) throw ReplicaStoreException("IO", "Could not create $dir")
        secrets.deleteAll()
        marker.createNewFile()
    }

    private fun deleteFiles(id: String) {
        for (suffix in SUFFIXES) File(dir, "$id.sqlite$suffix").delete()
    }

    private fun closeSession() {
        session?.let { runCatching { it.db.close() } }
        session = null
    }

    /** Maps anything that isn't already a contract error to IO. */
    private inline fun <T> guard(block: () -> T): T = try {
        block()
    } catch (e: ReplicaStoreException) {
        throw e
    } catch (e: Exception) {
        throw ReplicaStoreException("IO", e.message ?: e.toString())
    }

    @Synchronized
    fun open(account: String, maxBytes: Long?): OpenResult = guard {
        if (account.isEmpty()) throw ReplicaStoreException("INVALID_ARGUMENT", "account is required")
        if (maxBytes != null && maxBytes < 0) throw ReplicaStoreException("INVALID_ARGUMENT", "maxBytes must be >= 0")
        ensureMarker()
        session?.let {
            if (it.account == account) {
                it.maxBytes = maxBytes
                return@guard OpenResult(SCHEMA_VERSION, false)
            }
        }
        closeSession()
        val id = accountId(account)
        val file = dbFile(id)
        var secret = secrets.load(id)
        if (secret == null) {
            // A file without its secret can never be read again: start over.
            deleteFiles(id)
            secret = ByteArray(32).also { random.nextBytes(it); secrets.save(id, it) }
        }
        val dbKey = databaseKey(secret)
        var created = !file.exists()
        // A file this key can't open (damaged, or not ours) or one written by a newer build: it is only a copy of the
        // node's data, so drop it and copy again.
        var db = try {
            openDb(file, dbKey).also { if (it.userVersion > SCHEMA_VERSION) { it.close(); throw ReplicaDbUnreadable() } }
        } catch (e: ReplicaDbUnreadable) {
            deleteFiles(id)
            created = true
            openDb(file, dbKey)
        }
        try {
            if (db.userVersion == 0) {
                db.exec("CREATE TABLE IF NOT EXISTS kv(store TEXT NOT NULL, kmac BLOB NOT NULL, sealed BLOB NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(store, kmac)) WITHOUT ROWID")
                db.userVersion = SCHEMA_VERSION
            }
        } catch (e: Exception) {
            db.close()
            throw e
        }
        session = Session(account, id, db,
            hkdf(secret, ByteArray(0), "tc-replica/v1/enc".toByteArray(), 32),
            hkdf(secret, ByteArray(0), "tc-replica/v1/mac".toByteArray(), 32),
            maxBytes)
        OpenResult(SCHEMA_VERSION, created)
    }

    @Synchronized
    fun close() = closeSession()

    private fun requireOpen(): Session = session ?: throw ReplicaStoreException("NOT_OPEN", "No replica account is open")

    private fun kmac(s: Session, store: String, key: String) = hmac(s.macKey, store.toByteArray() + ZERO + key.toByteArray())

    private fun aad(store: String, kmac: ByteArray) = "tc-replica/v1".toByteArray() + ZERO + store.toByteArray() + ZERO + kmac

    private fun seal(s: Session, store: String, kmac: ByteArray, key: String, value: String): ByteArray {
        val keyBytes = key.toByteArray()
        val plain = ByteBuffer.allocate(4 + keyBytes.size).putInt(keyBytes.size).put(keyBytes).array() + value.toByteArray()
        val nonce = ByteArray(12).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(s.encKey, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad(store, kmac))
        return nonce + cipher.doFinal(plain)
    }

    /** Returns (key, value); auth failure or a malformed plaintext wipes the account and throws CORRUPT. */
    private fun unseal(s: Session, store: String, kmac: ByteArray, sealed: ByteArray): Pair<String, String> {
        try {
            if (sealed.size < 12 + 16) throw GeneralSecurityException("short blob")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(s.encKey, "AES"), GCMParameterSpec(128, sealed, 0, 12))
            cipher.updateAAD(aad(store, kmac))
            val plain = cipher.doFinal(sealed, 12, sealed.size - 12)
            if (plain.size < 4) throw GeneralSecurityException("short plaintext")
            val keyLen = ByteBuffer.wrap(plain, 0, 4).int
            if (keyLen < 0 || keyLen > plain.size - 4) throw GeneralSecurityException("bad key length")
            return String(plain, 4, keyLen) to String(plain, 4 + keyLen, plain.size - 4 - keyLen)
        } catch (e: GeneralSecurityException) {
            corrupt(s)
        }
    }

    private fun corrupt(s: Session): Nothing {
        wipeLocked(s.account)
        throw ReplicaStoreException("CORRUPT", "Replica data failed verification; the account's replica was wiped")
    }

    private fun getLocked(s: Session, store: String, key: String): String? {
        val kmac = kmac(s, store, key)
        val row = s.db.query("SELECT sealed FROM kv WHERE store = ? AND kmac = ?", listOf(store, kmac)).firstOrNull() ?: return null
        val (storedKey, value) = unseal(s, store, kmac, row[0] as ByteArray)
        if (storedKey != key) corrupt(s)
        return value
    }

    @Synchronized
    fun get(store: String, key: String): String? = guard { getLocked(requireOpen(), store, key) }

    @Synchronized
    fun getMany(store: String, keys: List<String>): List<String?> = guard {
        val s = requireOpen()
        keys.map { getLocked(s, store, it) }
    }

    @Synchronized
    fun list(store: String, prefix: String?, limit: Int?): List<Pair<String, String>> = guard {
        val s = requireOpen()
        if (limit != null && limit < 0) throw ReplicaStoreException("INVALID_ARGUMENT", "limit must be >= 0")
        val entries = s.db.query("SELECT kmac, sealed FROM kv WHERE store = ?", listOf(store)).map { row ->
            val kmac = row[0] as ByteArray
            val entry = unseal(s, store, kmac, row[1] as ByteArray)
            if (!kmac.contentEquals(kmac(s, store, entry.first))) corrupt(s)
            entry
        }
        val matching = entries.filter { prefix == null || it.first.startsWith(prefix) }.sortedWith { a, b -> compareUtf8(a.first, b.first) }
        if (limit != null) matching.take(limit) else matching
    }

    @Synchronized
    fun write(ops: List<WriteOp>): Unit = guard {
        val s = requireOpen()
        s.db.transaction {
            val budget = s.maxBytes
            val before = if (budget == null) 0L else usedBytes(s)
            for ((i, op) in ops.withIndex()) {
                fun missing(field: String): Nothing = throw ReplicaStoreException("INVALID_ARGUMENT", "ops[$i].$field is required")
                val store = op.store?.takeIf { it.isNotEmpty() } ?: missing("store")
                when (op.op) {
                    "put" -> {
                        val key = op.key ?: missing("key")
                        val value = op.value ?: missing("value")
                        val kmac = kmac(s, store, key)
                        s.db.exec("INSERT OR REPLACE INTO kv(store, kmac, sealed, size) VALUES (?, ?, ?, ?)",
                            listOf(store, kmac, seal(s, store, kmac, key, value), value.toByteArray().size.toLong()))
                    }
                    "delete" -> s.db.exec("DELETE FROM kv WHERE store = ? AND kmac = ?", listOf(store, kmac(s, store, op.key ?: missing("key"))))
                    "clear" -> s.db.exec("DELETE FROM kv WHERE store = ?", listOf(store))
                    else -> throw ReplicaStoreException("INVALID_ARGUMENT", "ops[$i].op must be put, delete or clear")
                }
            }
            // Over budget only when this batch grows the store: deletes must still be able to shrink one that is
            // already over (a lower budget on reopen).
            if (budget != null) {
                val used = usedBytes(s)
                if (used > budget && used > before) throw ReplicaStoreException("STORAGE_BUDGET", "Replica would use $used bytes, over the $budget byte budget")
            }
        }
    }

    private fun usedBytes(s: Session) = s.db.query("SELECT COALESCE(SUM(size), 0) FROM kv").first()[0] as Long

    @Synchronized
    fun estimate(): Estimate = guard { Estimate(session?.let { usedBytes(it) } ?: 0L, freeBytes()) }

    private fun wipeLocked(account: String) {
        if (session?.account == account) closeSession()
        val id = accountId(account)
        deleteFiles(id)
        secrets.delete(id)
    }

    @Synchronized
    fun wipe(account: String): Unit = guard {
        if (account.isEmpty()) throw ReplicaStoreException("INVALID_ARGUMENT", "account is required")
        ensureMarker()
        wipeLocked(account)
    }

    @Synchronized
    fun wipeAll(): Unit = guard {
        ensureMarker()
        closeSession()
        dir.listFiles()?.forEach { if (it.name != MARKER) it.deleteRecursively() }
        secrets.deleteAll()
    }
}
