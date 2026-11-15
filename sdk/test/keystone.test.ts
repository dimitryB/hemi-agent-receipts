import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import {
  abrevHash,
  coveringKeystone,
  decodePopOpReturn,
  findAll,
  keystoneAbrev,
  KeystoneError,
  l1OriginFromInput,
  popOpReturnScript,
  transactionsContaining,
  type AbrevCache,
} from "../src/index.js";
import { ESPLORA, fakeHemi, MAINNET_BLOCKS, POP_TXID, rawBlock, TESTNET } from "./finality-fakes.js";

/** The PoP OP_RETURN of keystone 5620225, as printed in docs/research/STATUS_RESOLUTION.md §3.2. */
const REPORT_SCRIPT =
  "0x6a4c5048454d4901019152a20055c20104ddfaf81653745406b60e74126bbe37be01ec07b3019776d53d3594a18254de5647f184ff8941746bf20761dd1045552e1af1c0cb793360d1b3e5d6c873e1408ddef4";
const REPORT_HASH = "0x6eaf6d4c73a5bca25c2721cb0a4f914c2bfa2b034e544576ccfa9c9a18273cbe";
const mainnet = () => fakeHemi({ chainId: 43_111, blocks: MAINNET_BLOCKS, latest: 5_620_740 });

describe("coveringKeystone", () => {
  test("B itself on a multiple of 25, else the next multiple", () => {
    assert.equal(coveringKeystone(5_620_209n), 5_620_225n);
    assert.equal(coveringKeystone(5_620_225n), 5_620_225n);
    assert.equal(coveringKeystone(5_620_226n), 5_620_250n);
    assert.equal(coveringKeystone(5_619_605), 5_619_625);
    assert.equal(coveringKeystone(1), 25);
    assert.equal(coveringKeystone(25), 25);
  });
});

describe("keystoneAbrev", () => {
  test("mainnet keystone 5620225 matches the report's OP_RETURN and abrev hash", async () => {
    const client = mainnet();
    const k = await keystoneAbrev(client, 5_620_225n);
    assert.equal(popOpReturnScript(k.abrev), REPORT_SCRIPT);
    assert.equal(k.abrevHash, REPORT_HASH);
    assert.equal(k.l1, 26_301_090);
    assert.equal(k.l2, 5_620_225);
    assert.equal(k.timestamp, 1_793_309_411);
    assert.equal(k.blockHash, MAINNET_BLOCKS["5620225"]!.hash.toLowerCase());
    assert.equal(client.calls.filter((c) => c.startsWith("eth_getBlockByNumber")).length, 2, "two Hemi RPC calls");
  });

  test("it equals the OP_RETURN of the real PoP tx d4ed6ec2…845e in Bitcoin block 973746", async () => {
    const k = await keystoneAbrev(mainnet(), 5_620_225);
    const script = ESPLORA.tx[POP_TXID]!.vout.map((v) => v.scriptpubkey).find((s) => s.startsWith("6a4c50"));
    assert.equal(`0x${script}`, popOpReturnScript(k.abrev));
  });

  test("testnet keystone 7099500 matches the report's abrev hash", async () => {
    const k = await keystoneAbrev(fakeHemi({ chainId: 743_111, blocks: TESTNET.blocks, latest: TESTNET.latest }), 7_099_500);
    assert.equal(k.abrevHash, "0x7be19b906da98bba80833c1a78db736c31d9b3cbe067172c954645b058117099");
  });

  test("old keystones are cached: the second read costs no RPC call", async () => {
    const client = mainnet();
    const cache: AbrevCache = new Map();
    const a = await keystoneAbrev(client, 5_620_225, { cache });
    const before = client.calls.length;
    assert.deepEqual(await keystoneAbrev(client, 5_620_225, { cache }), a);
    assert.equal(client.calls.length, before);
  });

  test("abrevHash is doubleSHA256 byte-reversed", () => {
    assert.equal(abrevHash(`0x${REPORT_SCRIPT.slice(16)}` as Hex), REPORT_HASH);
  });

  test("the Ecotone L1-info selector reads the same offset; any other selector is refused", () => {
    const input = (MAINNET_BLOCKS["5620225"]!.transactions[0] as { input: Hex }).input;
    assert.equal(l1OriginFromInput(input, 5_620_225), 26_301_090);
    assert.equal(l1OriginFromInput(`0x440a5e20${input.slice(10)}`, 5_620_225), 26_301_090);
    assert.throws(() => l1OriginFromInput(`0x015d8eb9${input.slice(10)}`, 5_620_225), /selector 0x015d8eb9, not setL1BlockValues \(Isthmus 0x098999be or Ecotone 0x440a5e20\)/);
  });

  test("errors: not a keystone, missing block, first tx not the L1-info deposit", async () => {
    await assert.rejects(keystoneAbrev(mainnet(), 5_620_209), (e: unknown) => e instanceof KeystoneError && /not a keystone block/.test(e.message));
    await assert.rejects(keystoneAbrev(mainnet(), 0), KeystoneError);
    const blocks = structuredClone(MAINNET_BLOCKS);
    (blocks["5620225"]!.transactions[0] as { to: string }).to = "0x0000000000000000000000000000000000000001";
    await assert.rejects(keystoneAbrev(fakeHemi({ chainId: 43_111, blocks, latest: 5_620_740 }), 5_620_225), /first transaction goes to 0x0+1, not the L1-info deposit/);
  });
});

describe("PoP OP_RETURN scripts", () => {
  test("decodePopOpReturn reads l2 and the abrev; popOpReturnScript round-trips", () => {
    const d = decodePopOpReturn(REPORT_SCRIPT.slice(2));
    assert.deepEqual(d, { l2: 5_620_225, abrev: `0x${REPORT_SCRIPT.slice(16)}` });
    assert.deepEqual(decodePopOpReturn(REPORT_SCRIPT.toUpperCase().replace("0X", "0x")), d);
    assert.equal(popOpReturnScript(d!.abrev), REPORT_SCRIPT);
  });

  test("anything else is null", () => {
    assert.equal(decodePopOpReturn(REPORT_SCRIPT.slice(0, -2)), null, "too short");
    assert.equal(decodePopOpReturn(`${REPORT_SCRIPT}00`), null, "too long");
    assert.equal(decodePopOpReturn(REPORT_SCRIPT.replace("48454d49", "48454d48")), null, "not HEMI");
    assert.equal(decodePopOpReturn("76a91444a2eab624146b6f8185a6af19645460e9f5f9a488ac"), null, "p2pkh");
    assert.throws(() => popOpReturnScript("0x1234"), /76 bytes/);
  });
});

describe("raw Bitcoin blocks", () => {
  test("finds the PoP tx and computes txids (legacy and segwit) from real transactions", () => {
    const pop = ESPLORA.txHex[POP_TXID]!;
    const coinbase = ESPLORA.txHex[ESPLORA.coinbaseTxid]!;
    const raw = rawBlock(1_793_309_506, [coinbase, pop]);
    const hits = findAll(raw, new Uint8Array([0x6a, 0x4c, 0x50, 0x48, 0x45, 0x4d, 0x49]));
    assert.equal(hits.length, 1);
    const [tx] = transactionsContaining(raw, hits);
    assert.equal(tx!.txid, `0x${POP_TXID}`);
    assert.ok(tx!.outputs.some((o) => o === REPORT_SCRIPT));
    const [cb] = transactionsContaining(raw, [90]);
    assert.equal(cb!.txid, `0x${ESPLORA.coinbaseTxid}`, "segwit txid excludes the witness");
    assert.deepEqual(transactionsContaining(raw, []), []);
  });
});
