const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { cidV1Raw, isValidCid } = require("../server/cid");
const { createServer } = require("../server/index");

/// 每个用例用独立的临时目录，互不污染
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentry-content-"));
}

function validSpec() {
  return {
    version: 1,
    capability: "contract.audit.owner-privileges",
    title: "BSC 合约 owner 权限审查",
    summary: "列出目标合约全部特权函数并评级风险",
    input: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "string", format: "address" } },
    },
    output: {
      type: "object",
      required: ["riskLevel"],
      properties: { riskLevel: { type: "string", enum: ["low", "medium", "high"] } },
    },
    acceptanceCriteria: ["覆盖全部 onlyOwner 函数，无遗漏"],
    rejections: ["仅复制源码而无分析"],
    samples: ["ipfs://bafysample"],
  };
}

describe("内容服务", function () {
  let server, base, dir;

  beforeEach(async function () {
    dir = tmpDir();
    server = createServer({ dir });
    await new Promise((r) => server.listen(0, r));
    base = "http://127.0.0.1:" + server.address().port;
  });

  afterEach(async function () {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* ================================================================== */
  describe("CID 生成", function () {
    it("空内容对上 IPFS 的已知向量", function () {
      // `ipfs add --cid-version=1 --raw-leaves` 对空文件的结果
      expect(cidV1Raw(Buffer.alloc(0))).to.equal(
        "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"
      );
    });

    it("形状正确", function () {
      const cid = cidV1Raw(Buffer.from("hello"));
      expect(cid).to.match(/^bafkrei[a-z2-7]{52}$/);
      expect(cid).to.have.length(59);
      expect(isValidCid(cid)).to.equal(true);
    });

    it("同样内容得同样 CID", function () {
      expect(cidV1Raw(Buffer.from("x"))).to.equal(cidV1Raw(Buffer.from("x")));
    });

    it("差一个字节就是另一个 CID", function () {
      expect(cidV1Raw(Buffer.from("abc"))).to.not.equal(cidV1Raw(Buffer.from("abd")));
    });

    it("挡得住路径穿越", function () {
      for (const bad of ["../../etc/passwd", "bafkrei", "", "BAFKREI" + "a".repeat(52)]) {
        expect(isValidCid(bad), bad).to.equal(false);
      }
    });
  });

  /* ================================================================== */
  describe("POST /spec", function () {
    it("合法规格返回 CID 与 specHash", async function () {
      const r = await fetch(base + "/spec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validSpec()),
      });
      expect(r.status).to.equal(201);

      const j = await r.json();
      expect(j.cid).to.match(/^bafkrei/);
      expect(j.uri).to.equal("ipfs://" + j.cid);
      expect(j.specHash).to.match(/^0x[0-9a-f]{64}$/);
    });

    it("存的是规范化字节 —— 两条验证路径必须得出同一个答案", async function () {
      // 陪审团可能直接哈希取回的原始字节，也可能解析后重新规范化再哈希。
      // 存规范化后的字节，这两条路才会一致
      const Spec = require("../lib/spec");
      const { ethers } = require("hardhat");

      const r = await fetch(base + "/spec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validSpec()),
      });
      const j = await r.json();

      const raw = await (await fetch(base + "/ipfs/" + j.cid)).text();
      const hashOfRawBytes = ethers.keccak256(ethers.toUtf8Bytes(raw));
      const hashOfReparsed = Spec.hash(JSON.parse(raw), ethers.keccak256, ethers.toUtf8Bytes);

      expect(hashOfRawBytes).to.equal(j.specHash);
      expect(hashOfReparsed).to.equal(j.specHash);
    });

    it("键序不同的同一份规格落到同一个 CID", async function () {
      const doc = validSpec();
      const reordered = {};
      for (const k of Object.keys(doc).reverse()) reordered[k] = doc[k];

      const post = (b) =>
        fetch(base + "/spec", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(b),
        }).then((r) => r.json());

      const a = await post(doc);
      const b = await post(reordered);
      expect(a.cid).to.equal(b.cid);
    });

    it("不合格的规格被拦在上链之前", async function () {
      const bad = validSpec();
      bad.acceptanceCriteria = [];

      const r = await fetch(base + "/spec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bad),
      });
      expect(r.status).to.equal(422);
      expect(JSON.stringify(await r.json())).to.include("acceptanceCriteria");
    });

    it("非法 JSON 返回 400", async function () {
      const r = await fetch(base + "/spec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ 这不是 json",
      });
      expect(r.status).to.equal(400);
    });

    it("警告会带回来，但不拦截", async function () {
      const doc = validSpec();
      delete doc.samples;
      const r = await fetch(base + "/spec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc),
      });
      expect(r.status).to.equal(201);
      expect(JSON.stringify((await r.json()).warnings)).to.include("samples");
    });
  });

  /* ================================================================== */
  describe("POST /content", function () {
    const put = (body, type) =>
      fetch(base + "/content", {
        method: "POST",
        headers: { "Content-Type": type },
        body,
      });

    it("存交付物并返回 CID", async function () {
      const r = await put("name,risk\nmint,high\n", "text/csv");
      expect(r.status).to.equal(201);
      const j = await r.json();
      expect(j.type).to.equal("text/csv");
      expect(j.inline).to.equal(true);
    });

    it("空内容被拒绝", async function () {
      const r = await put("", "text/plain");
      expect(r.status).to.equal(400);
    });

    it("超限被拒绝", async function () {
      const r = await put(Buffer.alloc(300 * 1024, 0x61), "text/plain");
      expect(r.status).to.equal(413);
    });

    it("存储总量满了返回 507，同样的内容重复上传不占额度", async function () {
      const d = tmpDir();
      const small = createServer({ dir: d, maxTotal: 100 });
      await new Promise((r) => small.listen(0, r));
      const b = "http://127.0.0.1:" + small.address().port;
      const send = (body) => fetch(b + "/content", { method: "POST", headers: { "Content-Type": "text/plain" }, body });
      try {
        expect((await send("a".repeat(80))).status).to.equal(201);
        expect((await send("a".repeat(80))).status).to.equal(201); // 已存在，不再占空间
        const full = await send("b".repeat(40));
        expect(full.status).to.equal(507);
        expect((await full.json()).error).to.include("存储空间已满");
        const h = await (await fetch(b + "/health")).json();
        expect(h.usedBytes).to.equal(80);
        expect(h.maxTotalBytes).to.equal(100);
      } finally {
        await new Promise((r) => small.close(r));
        fs.rmSync(d, { recursive: true, force: true });
      }
    });
  });

  /* ================================================================== */
  describe("取回与 XSS 防护", function () {
    it("JSON 内联返回", async function () {
      const up = await (await fetch(base + "/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"a":1}',
      })).json();

      const r = await fetch(base + "/ipfs/" + up.cid);
      expect(r.headers.get("content-type")).to.include("application/json");
      expect(r.headers.get("content-disposition")).to.equal("inline");
      expect(await r.text()).to.equal('{"a":1}');
    });

    it("HTML 交付物绝不内联渲染", async function () {
      // 陪审员**必须**打开交付物才能裁决。如果这里内联渲染 HTML，
      // 恶意服务方就能把 XSS 直接打在持币的陪审员脸上
      const up = await (await fetch(base + "/content", {
        method: "POST",
        headers: { "Content-Type": "text/html" },
        body: "<script>alert(1)</script>",
      })).json();

      expect(up.type).to.equal("application/octet-stream");
      expect(up.inline).to.equal(false);

      const r = await fetch(base + "/ipfs/" + up.cid);
      expect(r.headers.get("content-type")).to.equal("application/octet-stream");
      expect(r.headers.get("content-disposition")).to.equal("attachment");
    });

    it("SVG 同样不内联 —— 它能跑脚本", async function () {
      const up = await (await fetch(base + "/content", {
        method: "POST",
        headers: { "Content-Type": "image/svg+xml" },
        body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      })).json();

      expect(up.inline).to.equal(false);
      const r = await fetch(base + "/ipfs/" + up.cid);
      expect(r.headers.get("content-disposition")).to.equal("attachment");
    });

    it("真的 PNG 头像按图片内联返回", async function () {
      const png = require("fs").readFileSync(require("path").join(__dirname, "..", "brand", "agentry-icon-180.png"));
      const up = await (await fetch(base + "/content", {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: png,
      })).json();

      expect(up.type).to.equal("image/png");
      const r = await fetch(base + "/ipfs/" + up.cid);
      expect(r.headers.get("content-type")).to.equal("image/png");
      expect(r.headers.get("content-disposition")).to.equal("inline");
      expect(r.headers.get("x-content-type-options")).to.equal("nosniff");
    });

    it("声明是图片、内容不是的，降级成附件", async function () {
      const up = await (await fetch(base + "/content", {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: "<html><script>alert(1)</script></html>",
      })).json();

      expect(up.type).to.equal("application/octet-stream");
      const r = await fetch(base + "/ipfs/" + up.cid);
      expect(r.headers.get("content-disposition")).to.equal("attachment");
    });

    it("每个响应都带 nosniff 与 CSP", async function () {
      const up = await (await fetch(base + "/content", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "hi",
      })).json();

      const r = await fetch(base + "/ipfs/" + up.cid);
      expect(r.headers.get("x-content-type-options")).to.equal("nosniff");
      expect(r.headers.get("content-security-policy")).to.include("default-src 'none'");
      expect(r.headers.get("content-security-policy")).to.include("sandbox");
    });

    it("取不存在的 CID 返回 404", async function () {
      const r = await fetch(base + "/ipfs/bafkrei" + "a".repeat(52));
      expect(r.status).to.equal(404);
    });

    it("路径穿越返回 404 而不是文件内容", async function () {
      const r = await fetch(base + "/ipfs/..%2f..%2fpackage.json");
      expect(r.status).to.equal(404);
    });
  });

  /* ================================================================== */
  describe("其他接口", function () {
    it("/health 可用", async function () {
      const j = await (await fetch(base + "/health")).json();
      expect(j.ok).to.equal(true);
      expect(j.specVersion).to.equal(1);
      expect(j.pinDriver).to.equal("none");
    });

    it("/capabilities 返回分类表", async function () {
      const j = await (await fetch(base + "/capabilities")).json();
      expect(j.capabilities).to.be.an("array").and.not.empty;
    });

    it("未知路由返回 404", async function () {
      expect((await fetch(base + "/nope")).status).to.equal(404);
    });

    it("CORS 预检可用", async function () {
      const r = await fetch(base + "/spec", { method: "OPTIONS" });
      expect(r.status).to.equal(204);
      expect(r.headers.get("access-control-allow-origin")).to.equal("*");
    });
  });
});

/* ====================================================================== */

describe("IPFS 固定", function () {
  const { createPinner } = require("../server/pinner");
  const { cidV1Raw } = require("../server/cid");

  let servers = [];

  async function startWith(pinner) {
    const dir = tmpDir();
    const server = createServer({ dir, pinner });
    await new Promise((r) => server.listen(0, r));
    const base = "http://127.0.0.1:" + server.address().port;
    servers.push({ server, dir });
    return { server, base };
  }

  /// 老老实实返回正确 CID 的假驱动
  function goodPinner() {
    const calls = [];
    return {
      name: "fake-good",
      enabled: true,
      calls,
      async pin(cid) {
        calls.push(cid);
        return { ok: true, cid };
      },
    };
  }

  /// 返回**不同** CID 的假驱动。模拟对方用了 dag-pb 包装或没开 raw-leaves
  function mismatchPinner() {
    return {
      name: "fake-mismatch",
      enabled: true,
      async pin() {
        return { ok: true, cid: cidV1Raw(Buffer.from("something else entirely")) };
      },
    };
  }

  afterEach(async function () {
    for (const { server, dir } of servers) {
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
    servers = [];
  });

  const upload = (base, body) =>
    fetch(base + "/content", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body,
    }).then((r) => r.json());

  it("未配置时如实说没固定，并给出警告", async function () {
    const { base } = await startWith(createPinner({}));
    const j = await upload(base, "hello");

    expect(j.pinned).to.equal(false);
    expect(j.pin.driver).to.equal("none");
    expect(JSON.stringify(j.warnings)).to.include("未固定");
  });

  it("固定成功时标记为已固定", async function () {
    const p = goodPinner();
    const { base } = await startWith(p);
    const j = await upload(base, "hello");

    expect(j.pinned).to.equal(true);
    expect(p.calls).to.deep.equal([j.cid]);
  });

  it("⚠️ 返回的 CID 不一致 —— 必须当场失败，绝不静默接受", async function () {
    // 这是整个模块存在的理由。静默接受意味着上链的 URI 指向的内容地址
    // 和我们告诉用户的不是同一个，而这个错误会一直沉默到有人取不到交付物为止
    const { base } = await startWith(mismatchPinner());
    const j = await upload(base, "hello");

    expect(j.pinned).to.equal(false);
    expect(j.pin.cidMismatch).to.equal(true);
    expect(j.pin.returnedCid).to.not.equal(j.cid);
    expect(j.pin.error).to.include("不一致");
    expect(j.pin.error).to.include("raw-leaves"); // 告诉用户怎么修
  });

  it("驱动抛异常不会拖垮上传", async function () {
    const { base } = await startWith({
      name: "fake-throw",
      enabled: true,
      async pin() { throw new Error("网络炸了"); },
    });

    const j = await upload(base, "hello");
    expect(j.pinned).to.equal(false);
    expect(j.pin.error).to.include("网络炸了");
    // 内容仍然存下来了，仍然取得到
    expect((await fetch(base + "/ipfs/" + j.cid)).status).to.equal(200);
  });

  it("已固定过的内容不会重复提交", async function () {
    const p = goodPinner();
    const { base } = await startWith(p);

    await upload(base, "same content");
    await upload(base, "same content");

    expect(p.calls).to.have.length(1);
  });

  it("GET /pin/:cid 查状态", async function () {
    const { base } = await startWith(goodPinner());
    const j = await upload(base, "hello");

    const s = await (await fetch(base + "/pin/" + j.cid)).json();
    expect(s.pin.pinned).to.equal(true);
    expect(s.pin.driver).to.equal("fake-good");
  });

  it("POST /pin/:cid 重试之前失败的固定", async function () {
    let healthy = false;
    const { base } = await startWith({
      name: "fake-flaky",
      enabled: true,
      async pin(cid) {
        return healthy ? { ok: true, cid } : { ok: false, error: "暂时不可用" };
      },
    });

    const j = await upload(base, "hello");
    expect(j.pinned).to.equal(false);

    healthy = true;
    const retried = await (await fetch(base + "/pin/" + j.cid, { method: "POST" })).json();
    expect(retried.pin.pinned).to.equal(true);

    // 状态已经落盘
    const s = await (await fetch(base + "/pin/" + j.cid)).json();
    expect(s.pin.pinned).to.equal(true);
  });

  it("/health 统计已固定与未固定的数量", async function () {
    let healthy = true;
    const { base } = await startWith({
      name: "fake-switch",
      enabled: true,
      async pin(cid) {
        return healthy ? { ok: true, cid } : { ok: false, error: "不行" };
      },
    });

    await upload(base, "one");
    healthy = false;
    await upload(base, "two");

    const h = await (await fetch(base + "/health")).json();
    expect(h.stored).to.equal(2);
    expect(h.pinned).to.equal(1);
    expect(h.unpinned).to.equal(1);
  });

  it("不存在的 CID 查固定状态返回 404", async function () {
    const { base } = await startWith(goodPinner());
    const r = await fetch(base + "/pin/bafkrei" + "a".repeat(52));
    expect(r.status).to.equal(404);
  });

  describe("驱动选择", function () {
    it("默认不固定", function () {
      const p = createPinner({});
      expect(p.name).to.equal("none");
      expect(p.enabled).to.equal(false);
    });

    it("IPFS_API 选 kubo", function () {
      expect(createPinner({ IPFS_API: "http://127.0.0.1:5001" }).name).to.equal("kubo");
    });

    it("PINATA_JWT 选 pinata", function () {
      expect(createPinner({ PINATA_JWT: "x" }).name).to.equal("pinata");
    });

    it("两个都配时 kubo 优先 —— 它的 CID 必然一致", function () {
      const p = createPinner({ IPFS_API: "http://127.0.0.1:5001", PINATA_JWT: "x" });
      expect(p.name).to.equal("kubo");
    });
  });
});
