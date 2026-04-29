/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/ghbounty_escrow.json`.
 */
export type GhbountyEscrow = {
  "address": "CPZx26QXs3HjwGobr8cVAZEtF1qGzqnNbBdt7h1EwbBg",
  "metadata": {
    "name": "ghbountyEscrow",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "cancelBounty",
      "discriminator": [
        79,
        65,
        107,
        143,
        128,
        165,
        135,
        46
      ],
      "accounts": [
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "bounty",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "createBounty",
      "discriminator": [
        122,
        90,
        14,
        143,
        8,
        125,
        200,
        2
      ],
      "accounts": [
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "bounty",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  117,
                  110,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "arg",
                "path": "bountyId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "bountyId",
          "type": "u64"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "scorer",
          "type": "pubkey"
        },
        {
          "name": "githubIssueUrl",
          "type": "string"
        }
      ]
    },
    {
      "name": "resolveBounty",
      "discriminator": [
        207,
        43,
        93,
        238,
        222,
        184,
        79,
        219
      ],
      "accounts": [
        {
          "name": "creator",
          "signer": true
        },
        {
          "name": "bounty",
          "writable": true
        },
        {
          "name": "winningSubmission",
          "writable": true
        },
        {
          "name": "winner",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "setScore",
      "discriminator": [
        218,
        167,
        25,
        121,
        208,
        190,
        8,
        87
      ],
      "accounts": [
        {
          "name": "scorer",
          "signer": true
        },
        {
          "name": "bounty"
        },
        {
          "name": "submission",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "score",
          "type": "u8"
        }
      ]
    },
    {
      "name": "submitSolution",
      "discriminator": [
        203,
        233,
        157,
        191,
        70,
        37,
        205,
        0
      ],
      "accounts": [
        {
          "name": "solver",
          "writable": true,
          "signer": true
        },
        {
          "name": "bounty",
          "writable": true
        },
        {
          "name": "submission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  117,
                  98,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "bounty"
              },
              {
                "kind": "account",
                "path": "bounty.submission_count",
                "account": "bounty"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "prUrl",
          "type": "string"
        },
        {
          "name": "opusReportHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "bounty",
      "discriminator": [
        237,
        16,
        105,
        198,
        19,
        69,
        242,
        234
      ]
    },
    {
      "name": "submission",
      "discriminator": [
        58,
        194,
        159,
        158,
        75,
        102,
        178,
        197
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "zeroAmount",
      "msg": "Bounty amount must be greater than zero"
    },
    {
      "code": 6001,
      "name": "urlTooLong",
      "msg": "URL exceeds maximum length"
    },
    {
      "code": 6002,
      "name": "bountyNotOpen",
      "msg": "Bounty is not in the Open state"
    },
    {
      "code": 6003,
      "name": "unauthorizedCreator",
      "msg": "Only the bounty creator can perform this action"
    },
    {
      "code": 6004,
      "name": "submissionMismatch",
      "msg": "Submission does not belong to this bounty"
    },
    {
      "code": 6005,
      "name": "scoreOutOfRange",
      "msg": "Score must be between 1 and 10"
    },
    {
      "code": 6006,
      "name": "scoreAlreadySet",
      "msg": "Score has already been set on this submission"
    },
    {
      "code": 6007,
      "name": "unauthorizedScorer",
      "msg": "Only the designated scorer can set scores on this bounty"
    },
    {
      "code": 6008,
      "name": "lamportOverflow",
      "msg": "Lamport arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "bounty",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "scorer",
            "type": "pubkey"
          },
          {
            "name": "bountyId",
            "type": "u64"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "state",
            "type": {
              "defined": {
                "name": "bountyState"
              }
            }
          },
          {
            "name": "submissionCount",
            "type": "u32"
          },
          {
            "name": "winner",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "githubIssueUrl",
            "type": "string"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "bountyState",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "resolved"
          },
          {
            "name": "cancelled"
          }
        ]
      }
    },
    {
      "name": "submission",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bounty",
            "type": "pubkey"
          },
          {
            "name": "solver",
            "type": "pubkey"
          },
          {
            "name": "submissionIndex",
            "type": "u32"
          },
          {
            "name": "prUrl",
            "type": "string"
          },
          {
            "name": "opusReportHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "score",
            "type": {
              "option": "u8"
            }
          },
          {
            "name": "state",
            "type": {
              "defined": {
                "name": "submissionState"
              }
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "submissionState",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "pending"
          },
          {
            "name": "scored"
          },
          {
            "name": "winner"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "bountySeed",
      "type": "bytes",
      "value": "[98, 111, 117, 110, 116, 121]"
    },
    {
      "name": "submissionSeed",
      "type": "bytes",
      "value": "[115, 117, 98, 109, 105, 115, 115, 105, 111, 110]"
    }
  ]
};
