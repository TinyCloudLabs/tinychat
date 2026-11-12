package xyz.tinycloud.exo.replica

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Per-account 32-byte replica secrets, keyed by the account's hex sha256. */
interface SecretStore {
    fun load(id: String): ByteArray?
    fun save(id: String, secret: ByteArray)
    fun delete(id: String)
    fun deleteAll()
}

/**
 * Secrets wrapped with an AES-256-GCM Android Keystore key ([ALIAS]); each wrapped blob (nonce12 ‖ ct ‖ tag) lives in
 * `noBackupFilesDir/tinycloud-replica-keys/<id>.key`, so neither the blob nor the key survives a backup or reinstall.
 */
class KeystoreSecretStore(context: Context) : SecretStore {
    companion object {
        const val ALIAS = "tinycloud_replica_master"
        private const val PROVIDER = "AndroidKeyStore"
    }

    private val dir = File(context.noBackupFilesDir, "tinycloud-replica-keys")

    private fun keyStore() = KeyStore.getInstance(PROVIDER).apply { load(null) }

    private fun masterKey(create: Boolean): SecretKey? {
        (keyStore().getKey(ALIAS, null) as? SecretKey)?.let { return it }
        if (!create) return null
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build())
        return generator.generateKey()
    }

    private fun file(id: String) = File(dir, "$id.key")

    override fun load(id: String): ByteArray? {
        val blob = file(id).takeIf { it.isFile }?.readBytes() ?: return null
        val key = masterKey(create = false) ?: return null
        if (blob.size < 12 + 16) return null
        // A blob the Keystore key can't open (key lost or blob damaged) is as good as no secret: the core starts over.
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, blob, 0, 12))
            cipher.doFinal(blob, 12, blob.size - 12)
        } catch (e: java.security.GeneralSecurityException) {
            null
        }
    }

    override fun save(id: String, secret: ByteArray) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        // The Keystore picks the nonce (randomized encryption is enforced).
        cipher.init(Cipher.ENCRYPT_MODE, masterKey(create = true))
        val blob = cipher.iv + cipher.doFinal(secret)
        dir.mkdirs()
        val temp = File(dir, "$id.key.tmp")
        temp.writeBytes(blob)
        if (!temp.renameTo(file(id))) {
            temp.delete()
            throw ReplicaStoreException("IO", "Could not store the replica key")
        }
    }

    override fun delete(id: String) {
        file(id).delete()
    }

    override fun deleteAll() {
        dir.deleteRecursively()
        keyStore().let { if (it.containsAlias(ALIAS)) it.deleteEntry(ALIAS) }
    }
}
