import { retryRequest } from '@helpers/retryRequest'
import BottleneckModule from '@modules/bottleneck'
import ProviderModule from '@modules/provider'
import { type HexAddress, type NetworksEnum } from '@types'
import { Contract } from 'ethers'

const abi = [
  'function checkpoints() view returns (address)',
  'function votesSource() view returns (address)',
  'function getVotes(address) view returns (uint256)',
  'function bondedDelegate(address) view returns (address)',
]

export interface IBondedVotesSources {
  checkpoints: HexAddress
  votesSource: HexAddress
}

// Both are immutable in BondedVotes, so they are read once per token.
const sourcesCache = new Map<string, IBondedVotesSources>()

const read = async (token: HexAddress, network: NetworksEnum, method: string, ...args: string[]): Promise<any> => {
  const contract = new Contract(token, abi, ProviderModule.getAnyRpcProvider(network))
  return retryRequest(async () =>
    BottleneckModule.getNodeLimiter(network).schedule(async () => contract[method](...args)),
  )
}

// RPC errors propagate on purpose: skipping an account would leave its voting power stale for good.
const GovernanceBondedVotesHelper = {
  async getSources(token: HexAddress, network: NetworksEnum): Promise<IBondedVotesSources> {
    const key = `${network}-${token}`
    const cached = sourcesCache.get(key)
    if (cached) return cached

    const [checkpoints, votesSource] = await Promise.all([
      read(token, network, 'checkpoints'),
      read(token, network, 'votesSource'),
    ])
    sourcesCache.set(key, { checkpoints, votesSource })
    return { checkpoints, votesSource }
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
