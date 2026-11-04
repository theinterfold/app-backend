import { Models } from '@dbModels'
import { GovernanceBondedVotesHandler } from '@handlers/governanceBondedVotesHandler'
import { GovernanceErc20Handler } from '@handlers/governanceErc20Handler'
import GovernanceBondedVotesHelper from '@helpers/governanceBondedVotes'
import logger from '@logger'
import { Erc20Governance } from '@src/governance/erc20Governance'
import { NetworksEnum } from '@types'
import { expect } from 'chai'
import * as sinon from 'sinon'
import { SinonSandbox, SinonStub } from 'sinon'

describe('Handlers: GovernanceBondedVotesHandler', () => {
  let sandbox: SinonSandbox
  let getVotesStub: SinonStub
  let getBondedDelegateStub: SinonStub
  let createMembersStub: SinonStub
  let updateVotingPowerStub: SinonStub
  let updatePluginMetricsStub: SinonStub
  let updateDaoMetricsStub: SinonStub
  let delegateChangedBatchStub: SinonStub

  const network = NetworksEnum.ethereumSepolia
  const token = '0x4444444444444444444444444444444444444444'
  const checkpoints = '0x5555555555555555555555555555555555555555'
  const votesSource = '0x6666666666666666666666666666666666666666'
  const escrow = '0x8888888888888888888888888888888888888888'
  const alice = '0x1111111111111111111111111111111111111111'
  const bob = '0x2222222222222222222222222222222222222222'
  const carol = '0x3333333333333333333333333333333333333333'
  const zero = '0x0000000000000000000000000000000000000000'
  const plugin = { address: '0x7777777777777777777777777777777777777777', daoAddress: '0xDao' }

  const event = (name: string, args: Record<string, string>, address: string, blockNumber = 10) => ({
    parsedEvent: { name, args } as any,
    info: { address, network, blockNumber } as any,
  })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sandbox.stub(logger, 'error')
    sandbox.stub(Models.Token, 'find').resolves([{ address: token }] as any)
    sandbox.stub(GovernanceBondedVotesHelper, 'getSources').resolves({ checkpoints, votesSource, escrow })
    getVotesStub = sandbox.stub(GovernanceBondedVotesHelper, 'getVotes').callsFake(async (_t, _n, account) => {
      return account === alice ? 100n : 5n
    })
    getBondedDelegateStub = sandbox.stub(GovernanceBondedVotesHelper, 'getBondedDelegate').resolves(zero)
    sandbox.stub(Erc20Governance.prototype, 'getPlugins').resolves([plugin])
    createMembersStub = sandbox.stub(Erc20Governance, 'createMembersBatchNoTx').resolves(true)
    updateVotingPowerStub = sandbox.stub(Erc20Governance.prototype, 'updateTokenMemberVPBatchNoTx').resolves(true)
    updatePluginMetricsStub = sandbox.stub(Erc20Governance.prototype, 'updatePluginMetricsBatchNoTx').resolves(true)
    updateDaoMetricsStub = sandbox.stub(Erc20Governance.prototype, 'updateDaoMetrics').resolves()
    delegateChangedBatchStub = sandbox.stub(GovernanceErc20Handler, 'delegateChangedBatch').resolves()
  })

  afterEach(() => {
    sandbox?.restore()
  })

  describe('bondedDelegateChanged', () => {
    const delegation = () =>
      event('BondedDelegateChanged', { owner: alice, fromDelegate: zero, toDelegate: bob }, token)

    it('should log the delegation like an ERC20 DelegateChanged', async () => {
      await GovernanceBondedVotesHandler.bondedDelegateChanged(delegation().parsedEvent, delegation().info)

      const [logged] = delegateChangedBatchStub.firstCall.args[0]
      expect(logged.parsedEvent.args).to.deep.equal({ delegator: alice, fromDelegate: zero, toDelegate: bob })
      expect(logged.info.address).to.equal(token)
    })

    it('should refresh the voting power of the owner and the delegates, but not the zero address', async () => {
      await GovernanceBondedVotesHandler.bondedDelegateChanged(delegation().parsedEvent, delegation().info)

      const [updates] = updateVotingPowerStub.firstCall.args
      expect(updates).to.deep.equal([
        { memberAddress: alice, votingPower: '100', lastVPBlockNumber: 10 },
        { memberAddress: bob, votingPower: '5', lastVPBlockNumber: 10 },
      ])
      expect(createMembersStub.calledOnce).to.be.true
      expect(updateDaoMetricsStub.calledOnce).to.be.true
    })
  })

  describe('votingPowerChanged', () => {
    it('should refresh the bond owner and its bonded delegate on BondedCheckpointed', async () => {
      getBondedDelegateStub.resolves(carol)
      const { parsedEvent, info } = event('BondedCheckpointed', { bondOwner: alice }, checkpoints)

      await GovernanceBondedVotesHandler.votingPowerChanged(parsedEvent, info)

      expect(getBondedDelegateStub.calledOnceWith(token, network, alice)).to.be.true
      expect(updateVotingPowerStub.firstCall.args[0].map((update: any) => update.memberAddress)).to.have.members([
        alice,
        carol,
      ])
      expect(updatePluginMetricsStub.firstCall.args[0]).to.deep.include({
        pluginAddress: plugin.address,
        daoAddress: plugin.daoAddress,
        memberAddress: alice,
        lastActivity: 10,
      })
    })

    it('should refresh the delegate on a votes source DelegateVotesChanged', async () => {
      const { parsedEvent, info } = event('DelegateVotesChanged', { delegate: bob }, votesSource)

      await GovernanceBondedVotesHandler.votingPowerChanged(parsedEvent, info)

      expect(updateVotingPowerStub.firstCall.args[0]).to.deep.equal([
        { memberAddress: bob, votingPower: '5', lastVPBlockNumber: 10 },
      ])
    })

    it('should refresh delegator and delegates on a votes source DelegateChanged', async () => {
      const { parsedEvent, info } = event(
        'DelegateChanged',
        { delegator: alice, fromDelegate: bob, toDelegate: carol },
        votesSource,
      )

      await GovernanceBondedVotesHandler.votingPowerChanged(parsedEvent, info)

      expect(updateVotingPowerStub.firstCall.args[0].map((update: any) => update.memberAddress)).to.have.members([
        alice,
        bob,
        carol,
      ])
    })

    it('should refresh the depositor on an escrow Deposit and Withdraw', async () => {
      const deposit = event('Deposit', { depositor: alice }, escrow, 10)
      const withdraw = event('Withdraw', { depositor: bob }, escrow, 12)

      await GovernanceBondedVotesHandler.votingPowerChangedBatch([deposit, withdraw])

      expect(updateVotingPowerStub.firstCall.args[0]).to.deep.equal([
        { memberAddress: alice, votingPower: '100', lastVPBlockNumber: 10 },
        { memberAddress: bob, votingPower: '5', lastVPBlockNumber: 12 },
      ])
      expect(createMembersStub.firstCall.args[0].map((member: any) => member.memberAddress)).to.have.members([
        alice,
        bob,
      ])
    })

    it('should match a token whose votes source has no escrow', async () => {
      ;(GovernanceBondedVotesHelper.getSources as SinonStub).resolves({ checkpoints, votesSource, escrow: null })
      const { parsedEvent, info } = event('DelegateVotesChanged', { delegate: bob }, votesSource)

      await GovernanceBondedVotesHandler.votingPowerChanged(parsedEvent, info)

      expect(updateVotingPowerStub.calledOnce).to.be.true
    })

    it('should read each account once, at the latest block that touched it', async () => {
      await GovernanceBondedVotesHandler.votingPowerChangedBatch([
        event('DelegateVotesChanged', { delegate: bob }, votesSource, 20),
        event('DelegateVotesChanged', { delegate: bob }, votesSource, 30),
        event('DelegateVotesChanged', { delegate: bob }, votesSource, 25),
      ])

      expect(getVotesStub.calledOnce).to.be.true
      expect(updateVotingPowerStub.firstCall.args[0]).to.deep.equal([
        { memberAddress: bob, votingPower: '5', lastVPBlockNumber: 30 },
      ])
    })

    it('should ignore contracts that feed no BondedVotes token', async () => {
      const { parsedEvent, info } = event('BondedCheckpointed', { bondOwner: alice }, carol)

      await GovernanceBondedVotesHandler.votingPowerChanged(parsedEvent, info)

      expect(getVotesStub.called).to.be.false
      expect(updateVotingPowerStub.called).to.be.false
    })

    it('should skip tokens that no plugin uses', async () => {
      ;(Erc20Governance.prototype.getPlugins as SinonStub).resolves([])
      const { parsedEvent, info } = event('BondedCheckpointed', { bondOwner: alice }, checkpoints)

      await GovernanceBondedVotesHandler.votingPowerChanged(parsedEvent, info)

      expect(getVotesStub.called).to.be.false
      expect(updateVotingPowerStub.called).to.be.false
    })

    it('should write nothing and rethrow when voting power cannot be read', async () => {
      getVotesStub.rejects(new Error('rpc down'))
      const { parsedEvent, info } = event('BondedCheckpointed', { bondOwner: alice }, checkpoints)

      let error: Error | undefined
      try {
        await GovernanceBondedVotesHandler.votingPowerChanged(parsedEvent, info)
      } catch (err) {
        error = err as Error
      }

      expect(error?.message).to.equal('rpc down')
      expect(updateVotingPowerStub.called).to.be.false
    })
  })
})
