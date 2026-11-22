const { expect } = require("chai");
const { ethers } = require("hardhat");

const Spec = require("../lib/spec");
const REGISTRY = require("../lib/spec/capabilities.json");

const KNOWN = REGISTRY.capabilities.map((c) => c.id);

/// 一份完整合法的规格，大部分用例从它派生
function validSpec(overrides) {
  return Object.assign(
    {
      version: 1,
      capability: "contract.audit.owner-privileges",
      title: "BSC 合约 owner 权限审查",
      summary: "列出目标合约全部特权函数并评级风险",
      input: {
        type: "object",
        required: ["address", "chainId"],
        properties: {
          address: { type: "string", format: "address" },
          chainId: { type: "integer", enum: [56] },
        },
      },
      output: {
        type: "object",
        required: ["privilegedFunctions", "riskLevel"],
        properties: {
          privilegedFunctions: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["name", "canAffectUserAssets"],
              properties: {
                name: { type: "string", minLength: 1 },
                canAffectUserAssets: { type: "boolean" },
                note: { type: "string" },
              },
            },
          },
          riskLevel: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
      acceptanceCriteria: [
        "覆盖合约中全部 onlyOwner 修饰的函数，无遗漏",
        "每一项标注是否可影响用户资产",
      ],
      rejections: ["仅复制粘贴源码而无分析"],
      turnaround: 86400,
      samples: ["ipfs://bafysample"],
    },
    overrides || {}
  );
}

const VALID_INPUT = {
  address: "0x60b9262456de011f7d15a54cdd8c48baaa8b022f",
  chainId: 56,
};

const VALID_OUTPUT = {
  privilegedFunctions: [
    { name: "setTaxRate", canAffectUserAssets: false, note: "可改税率" },
    { name: "mint", canAffectUserAssets: true },
  ],
  riskLevel: "high",
};

describe("Capability Spec", function () {
  /* ================================================================== */
  describe("规范化序列化", function () {
    it("键序不影响结果", function () {
      const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
      const b = { c: { y: 2, z: 1 }, a: 2, b: 1 };
      expect(Spec.canonicalize(a)).to.equal(Spec.canonicalize(b));
    });

    it("输出无多余空白", function () {
      expect(Spec.canonicalize({ a: 1, b: [1, 2] })).to.equal('{"a":1,"b":[1,2]}');
    });

    it("数组保持顺序", function () {
      expect(Spec.canonicalize([3, 1, 2])).to.equal("[3,1,2]");
    });

    it("中文原样保留", function () {
      expect(Spec.canonicalize({ k: "验收标准" })).to.equal('{"k":"验收标准"}');
    });

    it("undefined 字段被剔除", function () {
      expect(Spec.canonicalize({ a: 1, b: undefined })).to.equal('{"a":1}');
    });

    it("拒绝 NaN 与 Infinity", function () {
      expect(() => Spec.canonicalize({ a: NaN })).to.throw();
      expect(() => Spec.canonicalize({ a: Infinity })).to.throw();
    });
  });

  /* ================================================================== */
  describe("specHash", function () {
    const h = (doc) => Spec.hash(doc, ethers.keccak256, ethers.toUtf8Bytes);

    it("三方能独立复现同一个哈希", function () {
      // 买方写的顺序和卖方读回来的顺序不同，哈希必须一致，
      // 否则陪审团无法验证「我读到的标准就是下单时锁定的那份」。
      // 这里把每一层的键序都倒过来，模拟不同实现的序列化差异
      const reorder = (v) => {
        if (Array.isArray(v)) return v.map(reorder);
        if (v && typeof v === "object") {
          const out = {};
          for (const k of Object.keys(v).reverse()) out[k] = reorder(v[k]);
          return out;
        }
        return v;
      };

      const asWritten = validSpec();
      const asReparsed = reorder(JSON.parse(JSON.stringify(asWritten)));

      // 先确认副本确实乱序了，否则这条测试什么也没测
      expect(JSON.stringify(asReparsed)).to.not.equal(JSON.stringify(asWritten));
      expect(h(asWritten)).to.equal(h(asReparsed));
    });

    it("内容变了哈希就变", function () {
      const base = validSpec();
      const tampered = validSpec({
        acceptanceCriteria: ["随便交点什么都算通过"],
      });
      expect(h(base)).to.not.equal(h(tampered));
    });

    it("返回 bytes32 形状", function () {
      expect(h(validSpec())).to.match(/^0x[0-9a-f]{64}$/);
    });
  });

  /* ================================================================== */
  describe("规格文档校验", function () {
    it("完整规格通过", function () {
      const r = Spec.validateSpec(validSpec(), { knownCapabilities: KNOWN });
      expect(r.errors, r.errors.join("; ")).to.be.empty;
      expect(r.ok).to.equal(true);
    });

    it("version 不对则拒绝", function () {
      const r = Spec.validateSpec(validSpec({ version: 2 }));
      expect(r.ok).to.equal(false);
      expect(r.errors.join()).to.include("version");
    });

    it("capability 格式不对则拒绝", function () {
      for (const bad of ["Contract.Audit", "contract", "contract..audit", "合约审查"]) {
        const r = Spec.validateSpec(validSpec({ capability: bad }));
        expect(r.ok, bad).to.equal(false);
      }
    });

    it("分类表外的能力只警告不拒绝", function () {
      // 分类表是发现层的便利，不是准入门槛。
      // 挡住表外能力就等于我们在预设分类，那和「市场自己长出模板」相悖
      const r = Spec.validateSpec(
        validSpec({ capability: "quantum.teleport.cat" }),
        { knownCapabilities: KNOWN }
      );
      expect(r.ok).to.equal(true);
      expect(r.warnings.join()).to.include("不在已知分类表内");
    });

    it("缺少验收标准则拒绝", function () {
      const r = Spec.validateSpec(validSpec({ acceptanceCriteria: [] }));
      expect(r.ok).to.equal(false);
      expect(r.errors.join()).to.include("acceptanceCriteria");
    });

    it("input / output 顶层必须是 object", function () {
      const r = Spec.validateSpec(validSpec({ output: { type: "string" } }));
      expect(r.ok).to.equal(false);
      expect(r.errors.join()).to.include("顶层 type 必须是 object");
    });

    it("标题过长则拒绝", function () {
      const r = Spec.validateSpec(validSpec({ title: "長".repeat(81) }));
      expect(r.ok).to.equal(false);
    });

    it("没写 rejections 会提醒", function () {
      const doc = validSpec();
      delete doc.rejections;
      const r = Spec.validateSpec(doc);
      expect(r.ok).to.equal(true);
      expect(r.warnings.join()).to.include("rejections");
    });

    it("没给样例会提醒", function () {
      const doc = validSpec();
      delete doc.samples;
      const r = Spec.validateSpec(doc);
      expect(r.warnings.join()).to.include("samples");
    });

    it("未知顶层字段只警告", function () {
      const r = Spec.validateSpec(validSpec({ price: 100 }));
      expect(r.ok).to.equal(true);
      expect(r.warnings.join()).to.include("price");
    });
  });

  /* ================================================================== */
  describe("Schema 方言限制", function () {
    const dialect = (s) => Spec.validateDialect(s);

    it("拒绝 $ref", function () {
      const r = dialect({ type: "object", properties: { a: { $ref: "#/x" } } });
      expect(r.ok).to.equal(false);
    });

    it("拒绝 oneOf / anyOf / allOf", function () {
      // 关键在于**报错**而不是静默忽略。
      // 静默忽略会让人以为 oneOf 生效了，其实没有，那比报错危险得多
      for (const kw of ["oneOf", "anyOf", "allOf", "not"]) {
        const s = { type: "object", properties: {} };
        s[kw] = [];
        const r = dialect(s);
        expect(r.ok, kw).to.equal(false);
        expect(r.errors.join()).to.include(kw);
      }
    });

    it("拒绝未知 type", function () {
      expect(dialect({ type: "null" }).ok).to.equal(false);
      expect(dialect({ type: "any" }).ok).to.equal(false);
    });

    it("array 必须声明 items", function () {
      const r = dialect({ type: "array" });
      expect(r.ok).to.equal(false);
      expect(r.errors.join()).to.include("items");
    });

    it("required 里的字段必须在 properties 里", function () {
      const r = dialect({
        type: "object",
        required: ["ghost"],
        properties: { real: { type: "string" } },
      });
      expect(r.ok).to.equal(false);
      expect(r.errors.join()).to.include("ghost");
    });

    it("拒绝不支持的 format", function () {
      const r = dialect({ type: "string", format: "email" });
      expect(r.ok).to.equal(false);
    });

    it("拒绝非法正则", function () {
      const r = dialect({ type: "string", pattern: "[" });
      expect(r.ok).to.equal(false);
    });

    it("拒绝过深的嵌套", function () {
      let s = { type: "string" };
      for (let i = 0; i < 12; i++) s = { type: "object", properties: { x: s } };
      expect(dialect(s).ok).to.equal(false);
    });

    it("关键字串台也会被拒绝", function () {
      // minLength 是字符串的关键字，用在 array 上应当报错
      const r = dialect({ type: "array", items: { type: "string" }, minLength: 1 });
      expect(r.ok).to.equal(false);
    });
  });

  /* ================================================================== */
  describe("输入校验", function () {
    const spec = validSpec();

    it("合法输入通过", function () {
      const r = Spec.validateInput(spec, VALID_INPUT);
      expect(r.errors, r.errors.join("; ")).to.be.empty;
    });

    it("缺必填字段被拒绝", function () {
      const r = Spec.validateInput(spec, { chainId: 56 });
      expect(r.ok).to.equal(false);
      expect(r.errors.join()).to.include("address");
    });

    it("地址格式不对被拒绝", function () {
      const r = Spec.validateInput(spec, { address: "0xdeadbeef", chainId: 56 });
      expect(r.ok).to.equal(false);
      expect(r.errors.join()).to.include("40 位");
    });

    it("enum 之外的值被拒绝", function () {
      const r = Spec.validateInput(spec, { address: VALID_INPUT.address, chainId: 1 });
      expect(r.ok).to.equal(false);
    });

    it("类型不对被拒绝", function () {
      const r = Spec.validateInput(spec, { address: VALID_INPUT.address, chainId: "56" });
      expect(r.ok).to.equal(false);
      expect(r.errors.join()).to.include("整数");
    });
  });

  /* ================================================================== */
  describe("交付物校验（争议裁决的客观前置）", function () {
    const spec = validSpec();

    it("合格交付物通过", function () {
      const r = Spec.validateOutput(spec, VALID_OUTPUT);
      expect(r.errors, r.errors.join("; ")).to.be.empty;
    });

    it("缺必填字段 —— 这是事实，不是品味", function () {
      // 陪审团介入之前任何人都能跑这一步。不符合声明的 schema 是客观事实，
      // 剩下的「符合结构但质量有争议」才需要人来判
      const r = Spec.validateOutput(spec, { riskLevel: "high" });
      expect(r.ok).to.equal(false);
      expect(r.errors.join()).to.include("privilegedFunctions");
    });

    it("数组元素里缺字段也能定位到下标", function () {
      const r = Spec.validateOutput(spec, {
        privilegedFunctions: [
          { name: "mint", canAffectUserAssets: true },
          { name: "pause" },
        ],
        riskLevel: "low",
      });
      expect(r.ok).to.equal(false);
      expect(r.errors.join()).to.include("[1].canAffectUserAssets");
    });

    it("空数组违反 minItems", function () {
      const r = Spec.validateOutput(spec, { privilegedFunctions: [], riskLevel: "low" });
      expect(r.ok).to.equal(false);
      expect(r.errors.join()).to.include("至少需要 1 项");
    });

    it("枚举外的风险等级被拒绝", function () {
      const r = Spec.validateOutput(spec, {
        privilegedFunctions: VALID_OUTPUT.privilegedFunctions,
        riskLevel: "catastrophic",
      });
      expect(r.ok).to.equal(false);
    });

    it("交了一堆无关字段但缺真正要的 —— 照样不过", function () {
      const r = Spec.validateOutput(spec, {
        notes: "我很努力了",
        wordCount: 5000,
      });
      expect(r.ok).to.equal(false);
      expect(r.errors.length).to.be.at.least(2);
    });
  });

  /* ================================================================== */
  describe("additionalProperties", function () {
    it("设为 false 时拒绝额外字段", function () {
      const spec = validSpec({
        input: {
          type: "object",
          required: ["a"],
          additionalProperties: false,
          properties: { a: { type: "string" } },
        },
      });
      expect(Spec.validateInput(spec, { a: "x" }).ok).to.equal(true);
      expect(Spec.validateInput(spec, { a: "x", b: "y" }).ok).to.equal(false);
    });

    it("默认允许额外字段", function () {
      expect(Spec.validateInput(validSpec(), Object.assign({ extra: 1 }, VALID_INPUT)).ok)
        .to.equal(true);
    });
  });

  /* ================================================================== */
  describe("能力分类表", function () {
    it("每条都是合法标识且不重复", function () {
      const re = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/;
      const seen = new Set();
      for (const c of REGISTRY.capabilities) {
        expect(c.id, c.id).to.match(re);
        expect(seen.has(c.id), "重复：" + c.id).to.equal(false);
        seen.add(c.id);
        expect(c.title).to.be.a("string").and.not.empty;
        expect(c.summary).to.be.a("string").and.not.empty;
      }
    });
  });
});
