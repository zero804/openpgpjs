/**
 * @requires enums
 * @requires key/helper
 * @requires packet
 * @module key/SubKey
 */

import enums from '../enums';
import * as helper from './helper';
import { PacketList } from '../packet';

/**
 * Class that represents a subkey packet and the relevant signatures.
 * @borrows PublicSubkeyPacket#getKeyId as SubKey#getKeyId
 * @borrows PublicSubkeyPacket#getFingerprint as SubKey#getFingerprint
 * @borrows PublicSubkeyPacket#hasSameFingerprintAs as SubKey#hasSameFingerprintAs
 * @borrows PublicSubkeyPacket#getAlgorithmInfo as SubKey#getAlgorithmInfo
 * @borrows PublicSubkeyPacket#getCreationTime as SubKey#getCreationTime
 * @borrows PublicSubkeyPacket#isDecrypted as SubKey#isDecrypted
 */
class SubKey {
  constructor(subKeyPacket) {
    if (!(this instanceof SubKey)) {
      return new SubKey(subKeyPacket);
    }
    this.keyPacket = subKeyPacket;
    this.bindingSignatures = [];
    this.revocationSignatures = [];
  }

  /**
   * Transforms structured subkey data to packetlist
   * @returns {PacketList}
   */
  toPacketlist() {
    const packetlist = new PacketList();
    packetlist.push(this.keyPacket);
    packetlist.concat(this.revocationSignatures);
    packetlist.concat(this.bindingSignatures);
    return packetlist;
  }

  /**
   * Checks if a binding signature of a subkey is revoked
   * @param  {SecretKeyPacket|
   *          PublicKeyPacket} primaryKey    The primary key packet
   * @param  {SignaturePacket}  signature     The binding signature to verify
   * @param  {PublicSubkeyPacket|
   *          SecretSubkeyPacket|
   *          PublicKeyPacket|
   *          SecretKeyPacket} key, optional The key to verify the signature
   * @param  {Date}                     date          Use the given date instead of the current time
   * @returns {Promise<Boolean>}                      True if the binding signature is revoked
   * @async
   */
  async isRevoked(primaryKey, signature, key, date = new Date()) {
    return helper.isDataRevoked(
      primaryKey, enums.signature.subkeyRevocation, {
        key: primaryKey,
        bind: this.keyPacket
      }, this.revocationSignatures, signature, key, date
    );
  }

  /**
   * Verify subkey. Checks for revocation signatures, expiration time
   * and valid binding signature.
   * @param  {SecretKeyPacket|
   *          PublicKeyPacket} primaryKey The primary key packet
   * @param  {Date}            date       Use the given date instead of the current time
   * @throws {Error}           if the subkey is invalid.
   * @async
   */
  async verify(primaryKey, date = new Date()) {
    const dataToVerify = { key: primaryKey, bind: this.keyPacket };
    // check subkey binding signatures
    const bindingSignature = await helper.getLatestValidSignature(this.bindingSignatures, primaryKey, enums.signature.subkeyBinding, dataToVerify, date);
    // check binding signature is not revoked
    if (bindingSignature.revoked || await this.isRevoked(primaryKey, bindingSignature, null, date)) {
      throw new Error('Subkey is revoked');
    }
    // check for expiration time
    if (helper.isDataExpired(this.keyPacket, bindingSignature, date)) {
      throw new Error('Subkey is expired');
    }
  }

  /**
   * Returns the expiration time of the subkey or Infinity if key does not expire
   * Returns null if the subkey is invalid.
   * @param  {SecretKeyPacket|
   *          PublicKeyPacket} primaryKey  The primary key packet
   * @param  {Date}            date        Use the given date instead of the current time
   * @returns {Promise<Date | Infinity | null>}
   * @async
   */
  async getExpirationTime(primaryKey, date = new Date()) {
    const dataToVerify = { key: primaryKey, bind: this.keyPacket };
    let bindingSignature;
    try {
      bindingSignature = await helper.getLatestValidSignature(this.bindingSignatures, primaryKey, enums.signature.subkeyBinding, dataToVerify, date);
    } catch (e) {
      return null;
    }
    const keyExpiry = helper.getExpirationTime(this.keyPacket, bindingSignature);
    const sigExpiry = bindingSignature.getExpirationTime();
    return keyExpiry < sigExpiry ? keyExpiry : sigExpiry;
  }

  /**
   * Update subkey with new components from specified subkey
   * @param  {module:key~SubKey}  subKey     Source subkey to merge
   * @param  {SecretKeyPacket|
              SecretSubkeyPacket} primaryKey primary key used for validation
   * @throws {Error} if update failed
   * @async
   */
  async update(subKey, primaryKey) {
    if (!this.hasSameFingerprintAs(subKey)) {
      throw new Error('SubKey update method: fingerprints of subkeys not equal');
    }
    // key packet
    if (this.keyPacket.tag === enums.packet.publicSubkey &&
        subKey.keyPacket.tag === enums.packet.secretSubkey) {
      this.keyPacket = subKey.keyPacket;
    }
    // update missing binding signatures
    const that = this;
    const dataToVerify = { key: primaryKey, bind: that.keyPacket };
    await helper.mergeSignatures(subKey, this, 'bindingSignatures', async function(srcBindSig) {
      for (let i = 0; i < that.bindingSignatures.length; i++) {
        if (that.bindingSignatures[i].issuerKeyId.equals(srcBindSig.issuerKeyId)) {
          if (srcBindSig.created > that.bindingSignatures[i].created) {
            that.bindingSignatures[i] = srcBindSig;
          }
          return false;
        }
      }
      try {
        srcBindSig.verified || await srcBindSig.verify(primaryKey, enums.signature.subkeyBinding, dataToVerify);
        return true;
      } catch (e) {
        return false;
      }
    });
    // revocation signatures
    await helper.mergeSignatures(subKey, this, 'revocationSignatures', function(srcRevSig) {
      return helper.isDataRevoked(primaryKey, enums.signature.subkeyRevocation, dataToVerify, [srcRevSig]);
    });
  }

  /**
   * Revokes the subkey
   * @param  {SecretKeyPacket} primaryKey decrypted private primary key for revocation
   * @param  {Object} reasonForRevocation optional, object indicating the reason for revocation
   * @param  {module:enums.reasonForRevocation} reasonForRevocation.flag optional, flag indicating the reason for revocation
   * @param  {String} reasonForRevocation.string optional, string explaining the reason for revocation
   * @param  {Date} date optional, override the creationtime of the revocation signature
   * @returns {Promise<module:key~SubKey>} new subkey with revocation signature
   * @async
   */
  async revoke(
    primaryKey,
    {
      flag: reasonForRevocationFlag = enums.reasonForRevocation.noReason,
      string: reasonForRevocationString = ''
    } = {},
    date = new Date()
  ) {
    const dataToSign = { key: primaryKey, bind: this.keyPacket };
    const subKey = new SubKey(this.keyPacket);
    subKey.revocationSignatures.push(await helper.createSignaturePacket(dataToSign, null, primaryKey, {
      signatureType: enums.signature.subkeyRevocation,
      reasonForRevocationFlag: enums.write(enums.reasonForRevocation, reasonForRevocationFlag),
      reasonForRevocationString
    }, date));
    await subKey.update(this, primaryKey);
    return subKey;
  }

  hasSameFingerprintAs(other) {
    return this.keyPacket.hasSameFingerprintAs(other.keyPacket || other);
  }
}

['getKeyId', 'getFingerprint', 'getAlgorithmInfo', 'getCreationTime', 'isDecrypted'].forEach(name => {
  SubKey.prototype[name] =
    function() {
      return this.keyPacket[name]();
    };
});

export default SubKey;
