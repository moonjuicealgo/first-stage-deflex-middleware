import algosdk from 'algosdk';

export const ZERO_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';

/**
 * Construct the box key for an asset.
 * Prefix 'a' + 8-byte asset ID
 */
export function getBoxKeyForAsset(assetId: number): Uint8Array {
  const buffer = new ArrayBuffer(9);
  const view = new DataView(buffer);
  view.setUint8(0, 0x61); // 'a'
  view.setBigUint64(1, BigInt(assetId), false); // big-endian
  return new Uint8Array(buffer);
}

/**
 * Construct the user deposit/freeze box key.
 * 8-byte asset ID + 32-byte user address
 */
export function getUserAssetBoxKey(assetId: number, address: string): Uint8Array {
  const assetBytes = new Uint8Array(8);
  new DataView(assetBytes.buffer).setBigUint64(0, BigInt(assetId), false);

  const addrBytes = algosdk.decodeAddress(address).publicKey;
  return new Uint8Array([...assetBytes, ...addrBytes]);
}

export async function getExemptWalletBoxKey(
  prefix: 'g' | 'r',
  address: string | algosdk.Address,
  algodClient?: algosdk.Algodv2
): Promise<Uint8Array> {
  const addrStr = typeof address === 'string' ? address : address.toString();
  let addrBytes = algosdk.decodeAddress(addrStr).publicKey;

  if (prefix === 'r' && algodClient) {
    const info = await algodClient.accountInformation(addrStr).do();
    // The contract keys this box on the AVM's `auth_address`, which is the zero address for
    // an account that has never been rekeyed. Falling back to the account's own address
    // produces a box name the contract never reads, and the app call is then rejected with
    // "invalid Box reference".
    const authAddr = info['authAddr'] ?? ZERO_ADDRESS;
    addrBytes = algosdk.decodeAddress(String(authAddr)).publicKey;
  }

  return new Uint8Array([...new TextEncoder().encode(prefix), ...addrBytes]);
}
