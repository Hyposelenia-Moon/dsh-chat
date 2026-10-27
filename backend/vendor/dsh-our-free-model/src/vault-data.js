/**
 * Seal material for the co-paid (EAC) lane was removed from this redistribution.
 *
 * The QQ bridge only uses the Kilo/free lanes, which never touch this seal, and
 * the original values are third-party credential material we should not ship.
 * `unlockSealedLane()` is documented to return null instead of a partial
 * credential, so an empty seal simply disables that optional lane.
 */

export const LANE_SHARDS = []
export const LANE_SEAL = ''
