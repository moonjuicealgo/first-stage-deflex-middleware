import algosdk from "algosdk";

export interface AssetInformation {
  admin_account: string;
  main_pool: string;
  liquidity_target: string;
  project_tax_bps: bigint;
  burn_tax_bps: bigint;
  reflection_tax_bps: bigint;
  freeze_tax_bps: bigint;
  liquidity_tax_bps: bigint;
  freeze_reward_bps: bigint;
  max_freeze_reward: bigint;
  liquidity_deposit_bps: bigint;
  eligible_for_reflections_total: bigint;
  freeze_rewards_available: bigint;
  reflections_tokens_available: bigint;
  reflections_algo_available: bigint;
  minimum_reflections: bigint;
  tokens_collected: bigint;
  algo_collected: bigint;
  pending_project_tax: bigint;
  pending_liquidity_tax: bigint;
  buy_tax: boolean;
  sell_tax: boolean;
  taxes_in_algo: boolean;
  total_tax_bps: bigint;
}


export interface UserAssetInfo {
  pending_reflections_tokens: bigint;
  pending_reflections_algo: bigint;
  claimable_freeze_rewards: bigint;
  registered_balance: bigint;
}

export interface UserDepositInfo {
  locked_asset_id: bigint;
  lp_deposit: bigint;
  locked_lp_tokens: bigint;
  lp_app_id: bigint;
  second_locked_asset_id: bigint;
  second_lp_deposit: bigint;
}

export function decodeAssetBox(bytes: Uint8Array): AssetInformation {
  const view = new DataView(bytes.buffer);

  const readUint64BE = (offset: number) => {
    const high = view.getUint32(offset, false);
    const low = view.getUint32(offset + 4, false);
    return BigInt(high) * 2n ** 32n + BigInt(low);
  };

  const admin_account = algosdk.encodeAddress(bytes.slice(0, 32));
  const main_pool = algosdk.encodeAddress(bytes.slice(32, 64));
  const liquidity_target = algosdk.encodeAddress(bytes.slice(104, 136));

  const flags = bytes[248];
  const buy_tax = (flags & 0b10000000) !== 0;
  const sell_tax = (flags & 0b01000000) !== 0;
  const taxes_in_algo = (flags & 0b00100000) !== 0;

  const total_tax_bps =
    readUint64BE(64) + // project
    readUint64BE(72) + // burn
    readUint64BE(80) + // reflection
    readUint64BE(88) + // freeze
    readUint64BE(96);  // liquidity

  return {
    admin_account,
    main_pool,
    liquidity_target,
    project_tax_bps: readUint64BE(64),
    burn_tax_bps: readUint64BE(72),
    reflection_tax_bps: readUint64BE(80),
    freeze_tax_bps: readUint64BE(88),
    liquidity_tax_bps: readUint64BE(96),
    freeze_reward_bps: readUint64BE(136),
    max_freeze_reward: readUint64BE(144),
    liquidity_deposit_bps: readUint64BE(152),
    eligible_for_reflections_total: readUint64BE(176),
    freeze_rewards_available: readUint64BE(184),
    reflections_tokens_available: readUint64BE(192),
    reflections_algo_available: readUint64BE(200),
    minimum_reflections: readUint64BE(208),
    tokens_collected: readUint64BE(216),
    algo_collected: readUint64BE(224),
    pending_project_tax: readUint64BE(232),
    pending_liquidity_tax: readUint64BE(240),
    buy_tax,
    sell_tax,
    taxes_in_algo,
    total_tax_bps,
  };
}

export function decodeUserDepositBox(bytes: Uint8Array): UserDepositInfo {
  if (bytes.length < 48) {
    throw new Error("UserDeposit box too short, expected at least 48 bytes");
  }

  const view = new DataView(bytes.buffer);

  const readUint64BE = (offset: number) => {
    const high = view.getUint32(offset, false);
    const low = view.getUint32(offset + 4, false);
    return BigInt(high) * 2n ** 32n + BigInt(low);
  };

  return {
    locked_asset_id: readUint64BE(0),
    lp_deposit: readUint64BE(8),
    locked_lp_tokens: readUint64BE(16),
    lp_app_id: readUint64BE(24),
    second_locked_asset_id: readUint64BE(32),
    second_lp_deposit: readUint64BE(40)
  };
}
