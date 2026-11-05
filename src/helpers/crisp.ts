import { CrispVoting } from '@artifacts/CrispVoting'
import { CrispProgram, Interfold } from '@artifacts/Interfold'
import { retryRequest } from '@helpers/retryRequest'
import BottleneckModule from '@modules/bottleneck'
import ProviderModule from '@modules/provider'
import { type HexAddress, type NetworksEnum } from '@types'
import { Contract, getAddress } from 'ethers'

// Reads of a CRISP plugin, its Interfold coordinator and the CRISP program. RPC errors propagate: callers isolate
// each read so one failure leaves its field unset instead of failing the event or the crawl.
const read = async (
  address: HexAddress,
  abi: readonly unknown[],
  network: NetworksEnum,
  method: string,
  ...args: unknown[]
): Promise<any> => {
  const contract = new Contract(address, abi as any, ProviderModule.getAnyRpcProvider(network))
  return retryRequest(async () =>
    BottleneckModule.getNodeLimiter(network).schedule(async () => contract[method](...args)),
  )
}

// `IInterfold.E3Stage`, the lifecycle stage of a round
export enum E3Stage {
  None,
  Requested,
  CommitteeFinalized,
  KeyPublished,
  CiphertextReady,
  Complete,
  Failed,
}

const stageDeadlineField: Partial<Record<E3Stage, 'dkgDeadline' | 'computeDeadline' | 'decryptionDeadline'>> = {
  [E3Stage.CommitteeFinalized]: 'dkgDeadline',
  [E3Stage.KeyPublished]: 'computeDeadline',
  [E3Stage.CiphertextReady]: 'decryptionDeadline',
}

const CrispHelper = {
  // The Interfold coordinator the plugin's rounds run on, checksummed
  async getInterfold(plugin: HexAddress, network: NetworksEnum): Promise<HexAddress> {
    return getAddress(await read(plugin, CrispVoting.abi, network, 'interfold')) as HexAddress
  },

  async getTotalVotingPower(plugin: HexAddress, network: NetworksEnum, snapshotBlock: bigint | number) {
    const power: bigint = await read(plugin, CrispVoting.abi, network, 'totalVotingPower', snapshotBlock)
    return power.toString()
  },

  // Counts of the round, in units of its voting power divisor. Reverts until the plaintext output is published.
  async getTally(plugin: HexAddress, network: NetworksEnum, proposalIndex: string): Promise<bigint[]> {
    const tally = await read(plugin, CrispVoting.abi, network, 'getTally', proposalIndex)
    return [...tally.counts]
  },

  // Whether the round has missed a deadline and may be marked failed, and the `FailureReason` it would get. Nothing
  // is emitted until someone calls `markE3Failed`, so the view is the only way to see it.
  async checkFailureCondition(interfold: HexAddress, e3Id: string, network: NetworksEnum) {
    const { canFail, reason } = await read(interfold, Interfold.abi, network, 'checkFailureCondition', e3Id)
    return { canFail: canFail as boolean, reason: Number(reason) }
  },

  async getE3Stage(interfold: HexAddress, e3Id: string, network: NetworksEnum): Promise<E3Stage> {
    return Number(await read(interfold, Interfold.abi, network, 'getE3Stage', e3Id))
  },

  // The `FailureReason` the coordinator stored when the round was marked failed
  async getFailureReason(interfold: HexAddress, e3Id: string, network: NetworksEnum): Promise<number> {
    return Number(await read(interfold, Interfold.abi, network, 'getFailureReason', e3Id))
  },

  // The deadline after which the round can be marked failed in `stage`, as `InterfoldLifecycle.failureCondition`
  // picks it, in seconds. Undefined for a `Requested` round, whose deadline the round's ciphernode registry holds,
  // and for the stages without one.
  async getStageDeadline(
    interfold: HexAddress,
    e3Id: string,
    stage: E3Stage,
    network: NetworksEnum,
  ): Promise<number | undefined> {
    const field = stageDeadlineField[stage]
    if (!field) return undefined
    const deadlines = await read(interfold, Interfold.abi, network, 'getDeadlines', e3Id)
    const deadline = Number(deadlines[field])
    return deadline > 0 ? deadline : undefined
  },

  // `getE3(e3Id).e3Program` is the CRISP program that set the divisor when the round was requested
  async getVotingPowerDivisor(interfold: HexAddress, e3Id: string, network: NetworksEnum): Promise<string> {
    const e3 = await read(interfold, Interfold.abi, network, 'getE3', e3Id)
    const divisor: bigint = await read(e3.e3Program, CrispProgram.abi, network, 'votingPowerDivisorOf', e3Id)
    return divisor.toString()
  },
}

export default CrispHelper
