import type CrispHelperType from '@helpers/crisp'
import BottleneckModule from '@modules/bottleneck'
import ProviderModule from '@modules/provider'
import { NetworksEnum } from '@types'
import { expect } from 'chai'
import proxyquire from 'proxyquire'
import * as sinon from 'sinon'
import { SinonSandbox } from 'sinon'

describe('Helpers: CrispHelper', () => {
  let sandbox: SinonSandbox
  let calls: { address: string; method: string; args: unknown[] }[]

  const network = NetworksEnum.ethereumSepolia
  const plugin = '0x1111111111111111111111111111111111111111'
  const interfold = '0x3333333333333333333333333333333333333333'
  const program = '0x8888888888888888888888888888888888888888'

  // Every contract read resolves to `reads[method]`, and is recorded
  const load = (reads: Record<string, unknown>) => {
    const { default: Helper } = proxyquire('@helpers/crisp', {
      ethers: {
        Contract: function (address: string) {
          return new Proxy(
            {},
            {
              get:
                (_target, method: string) =>
                async (...args: unknown[]) => {
                  calls.push({ address, method, args })
                  return reads[method]
                },
            },
          )
        },
      },
    })
    return Helper as typeof CrispHelperType
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    calls = []
    sandbox.stub(ProviderModule, 'getAnyRpcProvider').returns({} as any)
    sandbox
      .stub(BottleneckModule, 'getNodeLimiter')
      .returns({ schedule: async (fn: () => Promise<any>) => fn() } as any)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('should read the coordinator of the plugin, checksummed', async () => {
    const helper = load({ interfold: interfold.toLowerCase() })

    expect(await helper.getInterfold(plugin, network)).to.equal(interfold)
    expect(calls).to.deep.equal([{ address: plugin, method: 'interfold', args: [] }])
  })

  it('should read the total voting power at the snapshot', async () => {
    const helper = load({ totalVotingPower: 123456n })

    expect(await helper.getTotalVotingPower(plugin, network, 900n)).to.equal('123456')
    expect(calls).to.deep.equal([{ address: plugin, method: 'totalVotingPower', args: [900n] }])
  })

  it('should read the tally counts of a proposal', async () => {
    const helper = load({ getTally: { counts: [3n, 2n, 1n] } })

    expect(await helper.getTally(plugin, network, '4')).to.deep.equal([3n, 2n, 1n])
    expect(calls).to.deep.equal([{ address: plugin, method: 'getTally', args: ['4'] }])
  })

  it('should read whether a round can be marked failed, and why', async () => {
    const helper = load({ checkFailureCondition: { canFail: true, reason: 3n } })

    expect(await helper.checkFailureCondition(interfold, '7', network)).to.deep.equal({ canFail: true, reason: 3 })
    expect(calls).to.deep.equal([{ address: interfold, method: 'checkFailureCondition', args: ['7'] }])
  })

  it('should read the divisor from the program the coordinator holds for the round', async () => {
    const helper = load({ getE3: { e3Program: program }, votingPowerDivisorOf: 1000000n })

    expect(await helper.getVotingPowerDivisor(interfold, '7', network)).to.equal('1000000')
    expect(calls).to.deep.equal([
      { address: interfold, method: 'getE3', args: ['7'] },
      { address: program, method: 'votingPowerDivisorOf', args: ['7'] },
    ])
  })
})
