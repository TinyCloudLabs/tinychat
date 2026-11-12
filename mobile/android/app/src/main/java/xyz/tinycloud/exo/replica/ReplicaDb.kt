package xyz.tinycloud.exo.replica

import android.database.Cursor
import android.database.sqlite.SQLiteCursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteFullException
import java.io.File

/**
 * The slice of SQLite that [ReplicaStoreCore] needs. Bind args and result cells are `ByteArray`, `String`, `Long` or
 * null, so the core runs unchanged over Android's SQLite and over sqlite-jdbc in JVM tests.
 */
interface ReplicaDb {
    fun exec(sql: String, args: List<Any?> = emptyList())
    fun query(sql: String, args: List<Any?> = emptyList()): List<List<Any?>>
    /** Runs [block] in one transaction: committed when it returns, rolled back when it throws. */
    fun <T> transaction(block: () -> T): T
    var userVersion: Int
    fun close()
}

/** [ReplicaDb] over `android.database.sqlite`, WAL with synchronous=FULL. SQLITE_FULL surfaces as STORAGE_FULL. */
class AndroidReplicaDb private constructor(private val db: SQLiteDatabase) : ReplicaDb {
    companion object {
        fun open(file: File): ReplicaDb = full {
            val db = SQLiteDatabase.openDatabase(file.path, null,
                SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY or SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING)
            db.execSQL("PRAGMA synchronous=FULL")
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
        // rawQuery binds strings only; the factory binds blobs and longs on the compiled query.
        val factory = SQLiteDatabase.CursorFactory { _, driver, table, query ->
            args.forEachIndexed { i, arg ->
                when (arg) {
                    null -> query.bindNull(i + 1)
                    is ByteArray -> query.bindBlob(i + 1, arg)
                    is String -> query.bindString(i + 1, arg)
                    is Long -> query.bindLong(i + 1, arg)
                    is Int -> query.bindLong(i + 1, arg.toLong())
                    else -> throw IllegalArgumentException("Unsupported bind arg ${arg::class}")
                }
            }
            SQLiteCursor(driver, table, query)
        }
        db.rawQueryWithFactory(factory, sql, null, "").use { cursor ->
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
