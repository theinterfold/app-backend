export const CrispVoting = {
  abi: [
    {
      inputs: [],
      name: 'getE3Settings',
      outputs: [
        {
          internalType: 'enum IInterfold.CommitteeSize',
          name: '',
          type: 'uint8',
        },
        {
          internalType: 'uint8',
          name: '',
          type: 'uint8',
        },
        {
          internalType: 'bytes',
          name: '',
          type: 'bytes',
        },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [
        {
          internalType: 'uint256',
          name: '_proposalId',
          type: 'uint256',
        },
      ],
      name: 'getProposal',
      outputs: [
        {
          components: [
            {
              internalType: 'bool',
              name: 'executed',
              type: 'bool',
            },
            {
              components: [
                {
                  internalType: 'uint256',
                  name: 'numOptions',
                  type: 'uint256',
                },
                {
                  internalType: 'uint64',
                  name: 'startDate',
                  type: 'uint64',
                },
                {
                  internalType: 'uint64',
                  name: 'endDate',
                  type: 'uint64',
                },
                {
                  internalType: 'uint256',
                  name: 'snapshotBlock',
                  type: 'uint256',
                },
                {
                  internalType: 'uint256',
                  name: 'minVotingPower',
                  type: 'uint256',
                },
                {
                  internalType: 'uint256',
                  name: 'minParticipation',
                  type: 'uint256',
                },
                {
                  internalType: 'uint256',
                  name: 'supportThreshold',
                  type: 'uint256',
                },
                {
                  internalType: 'enum ICRISP.CreditMode',
                  name: 'creditMode',
                  type: 'uint8',
                },
              ],
              internalType: 'struct ICrispVoting.ProposalParameters',
              name: 'parameters',
              type: 'tuple',
            },
            {
              components: [
                {
                  internalType: 'uint256[]',
                  name: 'counts',
                  type: 'uint256[]',
                },
              ],
              internalType: 'struct ICrispVoting.TallyResults',
              name: 'tally',
              type: 'tuple',
            },
            {
              components: [
                {
                  internalType: 'address',
                  name: 'to',
                  type: 'address',
                },
                {
                  internalType: 'uint256',
                  name: 'value',
                  type: 'uint256',
                },
                {
                  internalType: 'bytes',
                  name: 'data',
                  type: 'bytes',
                },
              ],
              internalType: 'struct Action[]',
              name: 'actions',
              type: 'tuple[]',
            },
            {
              internalType: 'uint256',
              name: 'allowFailureMap',
              type: 'uint256',
            },
            {
              components: [
                {
                  internalType: 'address',
                  name: 'target',
                  type: 'address',
                },
                {
                  internalType: 'enum IPlugin.Operation',
                  name: 'operation',
                  type: 'uint8',
                },
              ],
              internalType: 'struct IPlugin.TargetConfig',
              name: 'targetConfig',
              type: 'tuple',
            },
            {
              internalType: 'uint256',
              name: 'e3Id',
              type: 'uint256',
            },
          ],
          internalType: 'struct ICrispVoting.Proposal',
          name: 'proposal_',
          type: 'tuple',
        },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [],
      name: 'minDuration',
      outputs: [
        {
          internalType: 'uint64',
          name: '',
          type: 'uint64',
        },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [],
      name: 'minParticipation',
      outputs: [
        {
          internalType: 'uint32',
          name: '',
          type: 'uint32',
        },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [],
      name: 'minProposerVotingPower',
      outputs: [
        {
          internalType: 'uint256',
          name: '',
          type: 'uint256',
        },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [],
      name: 'minVoterVotingPower',
      outputs: [
        {
          internalType: 'uint256',
          name: '',
          type: 'uint256',
        },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [],
      name: 'supportThreshold',
      outputs: [
        {
          internalType: 'uint32',
          name: '',
          type: 'uint32',
        },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      anonymous: false,
      inputs: [
        {
          indexed: false,
          internalType: 'enum IInterfold.CommitteeSize',
          name: 'committeeSize',
          type: 'uint8',
        },
        {
          indexed: false,
          internalType: 'uint8',
          name: 'paramSet',
          type: 'uint8',
        },
        {
          indexed: false,
          internalType: 'bytes',
          name: 'computeProviderParams',
          type: 'bytes',
        },
      ],
      name: 'E3SettingsUpdated',
      type: 'event',
    },
    {
      anonymous: false,
      inputs: [
        {
          indexed: false,
          internalType: 'uint256',
          name: 'minProposerVotingPower',
          type: 'uint256',
        },
        {
          indexed: false,
          internalType: 'uint256',
          name: 'minVoterVotingPower',
          type: 'uint256',
        },
        {
          indexed: false,
          internalType: 'uint32',
          name: 'minParticipation',
          type: 'uint32',
        },
        {
          indexed: false,
          internalType: 'uint32',
          name: 'supportThreshold',
          type: 'uint32',
        },
        {
          indexed: false,
          internalType: 'uint64',
          name: 'minDuration',
          type: 'uint64',
        },
      ],
      name: 'VotingSettingsUpdated',
      type: 'event',
    },
  ],
}
