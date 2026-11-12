package xyz.tinycloud.exo.replica

import org.junit.After
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.sql.Connection
import java.sql.DriverManager
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** [ReplicaDb] over sqlite-jdbc, configured like [AndroidReplicaDb] (WAL, synchronous=FULL). */
class JdbcReplicaDb(file: File) : ReplicaDb {
    private val conn: Connection = DriverManager.getConnection("jdbc:sqlite:${file.path}").also { c ->
        c.createStatement().use { it.executeQuery("PRAGMA journal_mode=WAL").close(); it.execute("PRAGMA synchronous=FULL") }
    }

    private fun prepare(sql: String, args: List<Any?>) = conn.prepareStatement(sql).also { st ->
        args.forEachIndexed { i, arg ->
            when (arg) {
                null -> st.setNull(i + 1, java.sql.Types.NULL)
                is ByteArray -> st.setBytes(i + 1, arg)
                is String -> st.setString(i + 1, arg)
                is Long -> st.setLong(i + 1, arg)
                else -> error("Unsupported arg $arg")
            }
        }
    }

    override fun exec(sql: String, args: List<Any?>) { prepare(sql, args).use { it.execute() } }

    override fun query(sql: String, args: List<Any?>): List<List<Any?>> = prepare(sql, args).use { st ->
        st.executeQuery().use { rs ->
            val rows = ArrayList<List<Any?>>()
            while (rs.next()) rows += (1..rs.metaData.columnCount).map { c ->
                when (val v = rs.getObject(c)) { is Int -> v.toLong(); else -> v }
            }
            rows
        }
    }

    override fun <T> transaction(block: () -> T): T {
        conn.autoCommit = false
        try {
            val result = block()
            conn.commit()
            return result
        } catch (e: Throwable) {
            conn.rollback()
            throw e
        } finally {
            conn.autoCommit = true
        }
    }

    override var userVersion: Int
        get() = (query("PRAGMA user_version").first()[0] as Long).toInt()
        set(value) = exec("PRAGMA user_version = $value")

    override fun close() = conn.close()
}

class MemorySecretStore : SecretStore {
    val secrets = HashMap<String, ByteArray>()
    override fun load(id: String) = secrets[id]?.copyOf()
    override fun save(id: String, secret: ByteArray) { secrets[id] = secret.copyOf() }
    override fun delete(id: String) { secrets.remove(id) }
    override fun deleteAll() = secrets.clear()
}

class ReplicaStoreCoreTest {
    private lateinit var root: File
    private lateinit var dir: File
    private lateinit var secrets: MemorySecretStore
    private lateinit var core: ReplicaStoreCore

    /** Keys each open was given, by file name. */
    private val keysUsed = mutableListOf<Pair<String, ByteArray>>()

    /** Plain SQLite stands in for SQLCipher; a file that isn't SQLite plays the part of "this key can't open it". */
    private fun newCore() = ReplicaStoreCore(dir, secrets, { file, key ->
        keysUsed += file.name to key
        if (file.isFile && file.length() > 0 && !file.readBytes().copyOf(15).contentEquals("SQLite format 3".toByteArray())) {
            throw ReplicaDbUnreadable()
        }
        JdbcReplicaDb(file)
    }, { 1234L })

    @Before fun setUp() {
        root = Files.createTempDirectory("replica-test").toFile()
        dir = File(root, "tinycloud-replica")
        secrets = MemorySecretStore()
        core = newCore()
    }

    @After fun tearDown() {
        core.close()
        root.deleteRecursively()
    }

    private fun put(store: String, key: String, value: String) = WriteOp("put", store, key, value)
    private fun file(account: String) = File(dir, "${ReplicaStoreCore.accountId(account)}.sqlite")
    private fun code(block: () -> Unit) = assertFailsWith<ReplicaStoreException> { block() }.code
    private fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun rawBytes(account: String): ByteArray =
        listOf("", "-wal", "-shm", "-journal").map { File(dir, "${ReplicaStoreCore.accountId(account)}.sqlite$it") }
            .filter { it.isFile }.fold(ByteArray(0)) { acc, f -> acc + f.readBytes() }
    private fun ByteArray.contains(needle: ByteArray) = (0..size - needle.size).any { i -> needle.indices.all { this[i + it] == needle[it] } }

    /** Flips one ciphertext bit in every sealed blob of [account]'s file. */
    private fun tamper(account: String) = DriverManager.getConnection("jdbc:sqlite:${file(account).path}").use { c ->
        val rows = c.createStatement().use { st ->
            st.executeQuery("SELECT store, kmac, sealed FROM kv").use { rs ->
                generateSequence { if (rs.next()) Triple(rs.getString(1), rs.getBytes(2), rs.getBytes(3)) else null }.toList()
            }
        }
        for ((store, kmac, sealed) in rows) {
            sealed[sealed.size - 20] = (sealed[sealed.size - 20].toInt() xor 1).toByte()
            c.prepareStatement("UPDATE kv SET sealed = ? WHERE store = ? AND kmac = ?").use {
                it.setBytes(1, sealed); it.setString(2, store); it.setBytes(3, kmac); it.executeUpdate()
            }
        }
    }

    @Test fun putGetRoundtrip() {
        assertEquals(OpenResult(1, true), core.open("alice", null))
        core.write(listOf(put("s", "k", "v1")))
        assertEquals("v1", core.get("s", "k"))
        assertNull(core.get("s", "missing"))
        assertNull(core.get("other", "k"))
        core.write(listOf(put("s", "k", "v2")))
        assertEquals("v2", core.get("s", "k"))
        assertEquals(1234L, core.estimate().freeBytes)
        assertEquals(2L, core.estimate().usedBytes)
    }

    @Test fun getManyKeepsOrderWithMisses() {
        core.open("alice", null)
        core.write(listOf(put("s", "a", "1"), put("s", "c", "3")))
        assertEquals(listOf("3", null, "1", null), core.getMany("s", listOf("c", "b", "a", "zz")))
    }

    @Test fun listPrefixUtf8OrderAndLimit() {
        core.open("alice", null)
        // UTF-8 byte order puts "p/é" (0xC3 0xA9) after "p/z"; UTF-16 order would agree here but "p/\uFFFF" vs
        // "p/😀" (surrogate 0xD83D < 0xFFFF in UTF-16, but 0xF0 > 0xEF in UTF-8) does not.
        core.write(listOf(put("s", "p/z", "z"), put("s", "p/é", "e"), put("s", "p/a", "a"),
            put("s", "p/\uFFFF", "ffff"), put("s", "p/😀", "smile"), put("s", "q/a", "other"), put("t", "p/b", "otherstore")))
        assertEquals(listOf("p/a", "p/z", "p/é", "p/\uFFFF", "p/😀"), core.list("s", "p/", null).map { it.first })
        assertEquals(listOf("p/a" to "a", "p/z" to "z"), core.list("s", "p/", 2))
        assertEquals(6, core.list("s", null, null).size)
        assertEquals(listOf("p/é" to "e"), core.list("s", "p/é", null))
    }

    @Test fun deleteAndClear() {
        core.open("alice", null)
        core.write(listOf(put("s", "a", "1"), put("s", "b", "2"), put("t", "a", "3")))
        core.write(listOf(WriteOp("delete", "s", "a")))
        assertNull(core.get("s", "a"))
        assertEquals("2", core.get("s", "b"))
        core.write(listOf(WriteOp("clear", "s")))
        assertEquals(emptyList(), core.list("s", null, null))
        assertEquals("3", core.get("t", "a"))
    }

    @Test fun invalidOpRollsBackWholeBatch() {
        core.open("alice", null)
        core.write(listOf(put("s", "keep", "old")))
        assertEquals("INVALID_ARGUMENT", code {
            core.write(listOf(put("s", "new", "1"), WriteOp("delete", "s", "keep"), WriteOp("bogus", "s", "x"), put("s", "late", "2")))
        })
        assertNull(core.get("s", "new"))
        assertNull(core.get("s", "late"))
        assertEquals("old", core.get("s", "keep"))
        assertEquals("INVALID_ARGUMENT", code { core.write(listOf(put("s", "new", "1"), WriteOp("put", "s", "k"))) })
        assertNull(core.get("s", "new"))
    }

    @Test fun dataSurvivesRestart() {
        core.open("alice", null)
        core.write(listOf(put("s", "k", "persisted")))
        core.close()
        core = newCore()
        assertEquals(OpenResult(1, false), core.open("alice", null))
        assertEquals("persisted", core.get("s", "k"))
    }

    @Test fun accountsAreIsolated() {
        core.open("alice", null)
        core.write(listOf(put("s", "k", "alice-value")))
        assertEquals(OpenResult(1, false), core.open("alice", null))
        assertEquals(OpenResult(1, true), core.open("bob", null))
        assertNull(core.get("s", "k"))
        assertEquals(emptyList(), core.list("s", null, null))
        assertNotEquals(file("alice"), file("bob"))
        assertTrue(file("alice").isFile && file("bob").isFile)
        core.open("alice", null)
        assertEquals("alice-value", core.get("s", "k"))
    }

    @Test fun wipeDeletesFilesAndSecret() {
        core.open("alice", null)
        core.write(listOf(put("s", "k", "v")))
        core.wipe("alice")
        assertEquals("NOT_OPEN", code { core.get("s", "k") })
        assertTrue(dir.listFiles()!!.none { it.name.startsWith(ReplicaStoreCore.accountId("alice")) })
        assertFalse(secrets.secrets.containsKey(ReplicaStoreCore.accountId("alice")))
        core.wipe("alice")
        assertEquals(OpenResult(1, true), core.open("alice", null))
        assertNull(core.get("s", "k"))
    }

    @Test fun wipeAllKeepsOnlyMarker() {
        core.open("alice", null)
        core.write(listOf(put("s", "k", "v")))
        core.open("bob", null)
        core.write(listOf(put("s", "k", "v")))
        core.wipeAll()
        assertEquals(listOf(ReplicaStoreCore.MARKER), dir.listFiles()!!.map { it.name })
        assertTrue(secrets.secrets.isEmpty())
        assertEquals("NOT_OPEN", code { core.get("s", "k") })
    }

    @Test fun nothingReadableAtRest() {
        core.open("alice", null)
        val key = "secret-key-name-\u00e9"
        val value = "very-private-value-${"x".repeat(50)}"
        core.write(listOf(put("notes", key, value)))
        core.close()
        val bytes = rawBytes("alice")
        assertTrue(bytes.isNotEmpty())
        assertFalse(bytes.contains(key.toByteArray()))
        assertFalse(bytes.contains("secret-key-name".toByteArray()))
        assertFalse(bytes.contains(value.toByteArray()))
        assertFalse(bytes.contains("very-private-value".toByteArray()))
    }

    @Test fun tamperedBlobIsCorruptAndWipesAccount() {
        core.open("alice", null)
        core.write(listOf(put("s", "k", "v")))
        core.close()
        tamper("alice")
        core = newCore()
        core.open("alice", null)
        assertEquals("CORRUPT", code { core.get("s", "k") })
        assertFalse(file("alice").exists())
        assertFalse(secrets.secrets.containsKey(ReplicaStoreCore.accountId("alice")))
        assertEquals("NOT_OPEN", code { core.get("s", "k") })
    }

    @Test fun tamperedListIsCorrupt() {
        core.open("alice", null)
        core.write(listOf(put("s", "k", "v")))
        core.close()
        tamper("alice")
        core = newCore()
        core.open("alice", null)
        assertEquals("CORRUPT", code { core.list("s", null, null) })
        assertFalse(file("alice").exists())
    }

    @Test fun dataCallsNeedOpenAccount() {
        assertEquals("NOT_OPEN", code { core.get("s", "k") })
        assertEquals("NOT_OPEN", code { core.getMany("s", listOf("k")) })
        assertEquals("NOT_OPEN", code { core.list("s", null, null) })
        assertEquals("NOT_OPEN", code { core.write(listOf(put("s", "k", "v"))) })
        assertEquals(Estimate(0, 1234L), core.estimate())
        core.open("alice", null)
        core.close()
        assertEquals("NOT_OPEN", code { core.get("s", "k") })
    }

    @Test fun storageBudgetRollsBack() {
        core.open("alice", 10)
        core.write(listOf(put("s", "a", "12345")))
        assertEquals("STORAGE_BUDGET", code { core.write(listOf(put("s", "b", "1234"), put("s", "c", "12"))) })
        assertNull(core.get("s", "b"))
        assertEquals(5L, core.estimate().usedBytes)
        // Replacing within budget, and a batch that ends within budget, are fine.
        core.write(listOf(put("s", "b", "12345678901"), WriteOp("delete", "s", "a"), put("s", "b", "é")))
        assertEquals(2L, core.estimate().usedBytes)
    }

    @Test fun overBudgetStoreCanStillShrink() {
        core.open("alice", null)
        core.write(listOf(put("s", "a", "1234567890"), put("s", "b", "1234567890")))
        core.open("alice", 5)
        // Still over budget afterwards, but smaller: allowed. Growing is not.
        core.write(listOf(WriteOp("delete", "s", "a")))
        assertEquals(10L, core.estimate().usedBytes)
        assertEquals("STORAGE_BUDGET", code { core.write(listOf(put("s", "c", "1"))) })
        core.write(listOf(WriteOp("clear", "s")))
        assertEquals(0L, core.estimate().usedBytes)
    }

    @Test fun invalidArgumentsAreRejected() {
        assertEquals("INVALID_ARGUMENT", code { core.open("alice", -1) })
        assertEquals("INVALID_ARGUMENT", code { core.wipe("") })
        core.open("alice", null)
        assertEquals("INVALID_ARGUMENT", code { core.list("s", null, -1) })
    }

    @Test fun databaseKeyIsPerAccountAndStable() {
        core.open("alice", null)
        core.open("bob", null)
        core.open("alice", null)
        val (aliceFirst, bobKey, aliceAgain) = keysUsed.map { it.second }
        assertEquals(32, aliceFirst.size)
        assertTrue(aliceFirst.contentEquals(aliceAgain))
        assertFalse(aliceFirst.contentEquals(bobKey))
        assertTrue(aliceFirst.contentEquals(ReplicaStoreCore.databaseKey(secrets.load(ReplicaStoreCore.accountId("alice"))!!)))
    }

    @Test fun fileThisKeyCannotOpenIsRecreated() {
        core.open("alice", null)
        core.write(listOf(put("s", "k", "v")))
        core.close()
        listOf("-wal", "-shm").forEach { File(file("alice").path + it).delete() }
        file("alice").writeBytes(ByteArray(8192) { 0x5a })
        assertTrue(core.open("alice", null).created)
        assertNull(core.get("s", "k"))
        core.write(listOf(put("s", "k", "again")))
        assertEquals("again", core.get("s", "k"))
    }

    @Test fun missingMarkerClearsOrphanSecrets() {
        secrets.save("orphan", ByteArray(32))
        core.open("alice", null)
        assertFalse(secrets.secrets.containsKey("orphan"))
        assertTrue(File(dir, ReplicaStoreCore.MARKER).isFile)
        // With the marker in place, existing secrets stay.
        secrets.save("kept", ByteArray(32))
        core.wipe("bob")
        assertTrue(secrets.secrets.containsKey("kept"))
    }

    @Test fun fileWithoutSecretStartsFresh() {
        core.open("alice", null)
        core.write(listOf(put("s", "k", "v")))
        core.close()
        secrets.delete(ReplicaStoreCore.accountId("alice"))
        core = newCore()
        assertEquals(OpenResult(1, true), core.open("alice", null))
        assertNull(core.get("s", "k"))
    }

    @Test fun newerSchemaIsRecreated() {
        core.open("alice", null)
        core.write(listOf(put("s", "k", "v")))
        core.close()
        DriverManager.getConnection("jdbc:sqlite:${file("alice").path}").use { c -> c.createStatement().use { it.execute("PRAGMA user_version = 7") } }
        core = newCore()
        assertEquals(OpenResult(1, true), core.open("alice", null))
        assertNull(core.get("s", "k"))
        core.close()
        DriverManager.getConnection("jdbc:sqlite:${file("alice").path}").use { c ->
            c.createStatement().use { st -> st.executeQuery("PRAGMA user_version").use { assertTrue(it.next()); assertEquals(1, it.getInt(1)) } }
        }
    }

    @Test fun hkdfMatchesRfc5869() {
        // Test Case 1 (with salt).
        assertContentEquals(
            hex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"),
            ReplicaStoreCore.hkdf(hex("0b".repeat(22)), hex("000102030405060708090a0b0c"), hex("f0f1f2f3f4f5f6f7f8f9"), 42))
        // Test Case 3 (empty salt, empty info).
        assertContentEquals(
            hex("8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"),
            ReplicaStoreCore.hkdf(hex("0b".repeat(22)), ByteArray(0), ByteArray(0), 42))
    }
}
