import { retryRequest } from '@helpers/retryRequest'
import utils from '@helpers/utils'
import BottleneckModule from '@modules/bottleneck'
import ProviderModule from '@modules/provider'
import { type HexAddress, type NetworksEnum } from '@types'
import { Contract } from 'ethers'

const abi = [
  'function checkpoints() view returns (address)',
  'function votesSource() view returns (address)',
  'function escrow() view returns (address)',
  'function getVotes(address) view returns (uint256)',
  'function bondedDelegate(address) view returns (address)',
]

interface IBondedVotesSources {
  checkpoints: HexAddress
  votesSource: HexAddress
  // the escrow behind an escrow votes source, null when the token votes for itself
  escrow: HexAddress | null
}

// All immutable in BondedVotes, so they are read once per token.
const sourcesCache = new Map<string, IBondedVotesSources>()
// A token that cannot report its sources (not a BondedVotes, or reverting) is not read again for a while.
const SOURCES_FAILURE_TTL_MS = 60_000
const sourcesFailures = new Map<string, { error: unknown; until: number }>()
const startBlockCache = new Map<string, number>()

const schedule = async <T>(network: NetworksEnum, call: () => Promise<T>): Promise<T> =>
  retryRequest(async () => BottleneckModule.getNodeLimiter(network).schedule(call))

const read = async (token: HexAddress, network: NetworksEnum, method: string, ...args: string[]): Promise<any> => {
  const contract = new Contract(token, abi, ProviderModule.getAnyRpcProvider(network))
  return schedule(network, async () => contract[method](...args))
}

// Smallest block at which `address` has code. Needs an archive node, like any historical crawl.
const getCreationBlock = async (address: HexAddress, network: NetworksEnum): Promise<number> => {
  const provider = ProviderModule.getAnyRpcProvider(network)
  const hasCode = async (block: number) =>
    (await schedule(network, async () => provider.getCode(address, block))) !== '0x'

  let high = await schedule(network, async () => provider.getBlockNumber())
  if (!(await hasCode(high))) throw new Error(`No contract code at ${address}`)

  let low = 0
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (await hasCode(mid)) high = mid
    else low = mid + 1
  }
  return low
}

// RPC errors propagate on purpose: skipping an account would leave its voting power stale for good.
const GovernanceBondedVotesHelper = {
  async getSources(token: HexAddress, network: NetworksEnum): Promise<IBondedVotesSources> {
    const key = `${network}-${token}`
    const cached = sourcesCache.get(key)
    if (cached) return cached

    const failure = sourcesFailures.get(key)
    if (failure && failure.until > Date.now()) throw failure.error

    try {
      const [checkpoints, votesSource, escrow] = await Promise.all([
        read(token, network, 'checkpoints'),
        read(token, network, 'votesSource'),
        read(token, network, 'escrow'),
      ])
      const sources = { checkpoints, votesSource, escrow: escrow === utils.zeroAddress ? null : escrow }
      sourcesCache.set(key, sources)
      return sources
    } catch (error) {
      sourcesFailures.set(key, { error, until: Date.now() + SOURCES_FAILURE_TTL_MS })
      throw error
    }
  },

  // First block of the history behind the token's voting power. The votes source and its escrow are
  // deployed before BondedVotes, and carry the delegations and locks, so the token's own creation block
  // (or the plugin's) would skip them.
  async getStartBlock(token: HexAddress, network: NetworksEnum): Promise<number> {
    const key = `${network}-${token}`
    const cached = startBlockCache.get(key)
    if (cached !== undefined) return cached

    const { checkpoints, votesSource, escrow } = await GovernanceBondedVotesHelper.getSources(token, network)
    const contracts = [...new Set([token, checkpoints, votesSource, escrow])].filter((a): a is HexAddress => !!a)
    const blocks = await Promise.all(contracts.map(async address => getCreationBlock(address, network)))
    const startBlock = Math.min(...blocks)
    startBlockCache.set(key, startBlock)
    return startBlock
  },

  // Voting power as the voting plugins read it: votes source plus bonded weight.
  async getVotes(token: HexAddress, network: NetworksEnum, account: HexAddress): Promise<bigint> {
    return read(token, network, 'getVotes', account)
  },

  async getBondedDelegate(token: HexAddress, network: NetworksEnum, owner: HexAddress): Promise<HexAddress> {
    return read(token, network, 'bondedDelegate', owner)
  },
}

export default GovernanceBondedVotesHelper
