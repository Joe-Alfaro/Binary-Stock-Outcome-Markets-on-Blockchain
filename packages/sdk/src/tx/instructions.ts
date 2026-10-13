import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import type { AccountMeta, AddressLookupTableAccount } from '@solana/web3.js'
import type { MarketAccounts } from './types.js'

/** Instruction helpers shared by the trade and redeem builders. Not exported from the SDK. */

export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111')

export type Method =
  'mint_pair' | 'merge_pair_up_to' | 'place_order' | 'cancel_order' | 'settle_funds' | 'redeem'

/** Anchor instruction discriminators: the first 8 bytes of `sha256("global:<method>")`. */
const DISCRIMINATOR: Record<Method, Buffer> = {
  mint_pair: Buffer.from([19, 149, 94, 110, 181, 186, 33, 107]),
  merge_pair_up_to: Buffer.from([24, 95, 222, 136, 113, 222, 25, 154]),
  place_order: Buffer.from([51, 194, 155, 175, 109, 130, 96, 106]),
  cancel_order: Buffer.from([95, 129, 237, 240, 8, 49, 223, 132]),
  settle_funds: Buffer.from([238, 64, 163, 96, 75, 171, 16, 33]),
  redeem: Buffer.from([184, 12, 86, 149, 70, 196, 97, 225]),
}

/** What every builder needs to address the wallet's accounts and compile a message. */
export interface TxBase {
  owner: PublicKey
  market: MarketAccounts
  recentBlockhash: string
  lookupTables?: AddressLookupTableAccount[]
}

export function compile(ctx: TxBase, instructions: TransactionInstruction[]): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: ctx.owner,
    recentBlockhash: ctx.recentBlockhash,
    instructions,
  }).compileToV0Message(ctx.lookupTables)
  return new VersionedTransaction(message)
}

export function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0]
}

export type MintName = 'usdcMint' | 'yesMint' | 'noMint'

/** `CreateIdempotent` for each of the wallet's token accounts, paid by the wallet. */
export function createAccounts(ctx: TxBase, mints: MintName[]): TransactionInstruction[] {
  return mints.map((name) => {
    const mint = ctx.market[name]
    return new TransactionInstruction({
      programId: ATA_PROGRAM,
      keys: [
        writable(ctx.owner, true),
        writable(ata(ctx.owner, mint)),
        readonly(ctx.owner),
        readonly(mint),
        readonly(SYSTEM_PROGRAM),
        readonly(TOKEN_PROGRAM),
      ],
      data: Buffer.from([1]),
    })
  })
}

export function settleFunds(ctx: TxBase): TransactionInstruction {
  const m = ctx.market
  return meridian(
    ctx,
    'settle_funds',
    [
      readonly(ctx.owner, true),
      readonly(m.market),
      writable(m.book),
      writable(m.yesEscrow),
      writable(m.usdcEscrow),
      writable(ata(ctx.owner, m.yesMint)),
      writable(ata(ctx.owner, m.usdcMint)),
      readonly(TOKEN_PROGRAM),
    ],
    [],
  )
}

export function meridian(
  ctx: TxBase,
  method: Method,
  keys: AccountMeta[],
  args: Buffer[],
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ctx.market.programId,
    keys,
    data: Buffer.concat([DISCRIMINATOR[method], ...args]),
  })
}

export function u64(value: number | bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(value))
  return buf
}

export function writable(pubkey: PublicKey, isSigner = false): AccountMeta {
  return { pubkey, isSigner, isWritable: true }
}

export function readonly(pubkey: PublicKey, isSigner = false): AccountMeta {
  return { pubkey, isSigner, isWritable: false }
}
