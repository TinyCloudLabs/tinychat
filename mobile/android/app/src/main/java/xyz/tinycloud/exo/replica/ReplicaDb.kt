package xyz.tinycloud.exo.replica

import android.database.Cursor
import android.database.sqlite.SQLiteDatabaseCorruptException
import android.database.sqlite.SQLiteFullException
import net.zetetic.database.sqlcipher.SQLiteDatabase
import net.zetetic.database.sqlcipher.SQLiteNotADatabaseException
import java.io.File

/**
 * The slice of SQLite that [ReplicaStoreCore] needs. Bind args and result cells are `ByteArray`, `String`, `Long` or
 * null, so the core runs unchanged over SQLCipher and over sqlite-jdbc in JVM tests.
 */
interface ReplicaDb {
    fun exec(sql: String, args: List<Any?> = emptyList())
    fun query(sql: String, args: List<Any?> = emptyList()): List<List<Any?>>
    /** Runs [block] in one transaction: committed when it returns, rolled back when it throws. */
    fun <T> transaction(block: () -> T): T
    var userVersion: Int
    fun close()
}

/** The opener's answer when [key] does not open the file: another key's file, plaintext or damage. */
class ReplicaDbUnreadable : Exception("the replica file cannot be opened with this key")

/**
 * [ReplicaDb] over SQLCipher (D-S5): whole-file encryption with a raw 256-bit key (no passphrase KDF), SQLCipher 4
 * defaults (HMAC page authentication on), WAL with synchronous=FULL, temp_store=MEMORY. SQLITE_FULL surfaces as
 * STORAGE_FULL.
 */
class AndroidReplicaDb private constructor(private val db: SQLiteDatabase) : ReplicaDb {
    companion object {
        init {
            System.loadLibrary("sqlcipher")
        }

        /** Throws [ReplicaDbUnreadable] when [key] does not open an existing file. */
        fun open(file: File, key: ByteArray): ReplicaDb = full {
            // `x'<hex>'` is SQLCipher's raw-key form: the bytes are the page key, no PBKDF2.
            val raw = "x'${key.joinToString("") { "%02x".format(it) }}'".toByteArray()
            // The default corruption handler would delete just the main file; the core deletes all of them instead.
            val db = try {
                SQLiteDatabase.openDatabase(file.path, raw, null,
                    SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY or SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING,
                    { _, _ -> }, null)
            } catch (e: SQLiteNotADatabaseException) {
                throw ReplicaDbUnreadable()
            } catch (e: SQLiteDatabaseCorruptException) {
                throw ReplicaDbUnreadable()
            }
            db.rawQuery("PRAGMA synchronous=FULL").use { it.moveToFirst() }
            db.rawQuery("PRAGMA temp_store=MEMORY").use { it.moveToFirst() }
            AndroidReplicaDb(db)
        }

        private inline fun <T> full(block: () -> T): T = try {
            block()
        } catch (e: SQLiteFullException) {
            throw ReplicaStoreException("STORAGE_FULL", e.message ?: "Disk full")
        }
    }

    override fun exec(sql: String, args: List<Any?>) = full { db.execSQL(sql, args.toTypedArray()) }

    override fun query(sql: String, args: List<Any?>): List<List<Any?>> = full {
        db.rawQuery(sql, *args.map { if (it is Int) it.toLong() else it }.toTypedArray()).use { cursor ->
            val rows = ArrayList<List<Any?>>()
            while (cursor.moveToNext()) {
                rows += (0 until cursor.columnCount).map { c ->
                    when (cursor.getType(c)) {
                        Cursor.FIELD_TYPE_NULL -> null
                        Cursor.FIELD_TYPE_BLOB -> cursor.getBlob(c)
                        Cursor.FIELD_TYPE_INTEGER -> cursor.getLong(c)
                        else -> cursor.getString(c)
                    }
                }
            }
            rows
        }
    }

    override fun <T> transaction(block: () -> T): T = full {
        db.beginTransaction()
        try {
            val result = block()
            db.setTransactionSuccessful()
            result
        } finally {
            db.endTransaction()
        }
    }

    override var userVersion: Int
        get() = full { db.version }
        set(value) = full { db.version = value }

    override fun close() = db.close()
}
