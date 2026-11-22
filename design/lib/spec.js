/* 自动生成，请勿直接修改。
   源文件 lib/spec/index.js，改完跑 `npm run sync:web` 重新生成。 */
/* ==========================================================================
   Agentry Capability Spec v1 —— 规格定义与校验器

   规格同时承担两个角色：
     1. 给人看的验收标准，陪审团据此裁决
     2. 给机器用的接口定义，Agent 据此构造输入、解析输出

   零依赖，Node / 浏览器 / 任意 Skill 运行时跑的是同一份代码。
   ========================================================================== */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AgentrySpec = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION = 1;

  /* ======================================================================
     1. 规范化序列化

     specHash 必须能被买方、卖方、陪审团三方独立复现。JSON 没有规范形式——
     键序、空白、转义都可能变，IPFS 网关和 CDN 也可能重新编码。
     所以先规范化再哈希。

     规则对齐 RFC 8785（JSON Canonicalization Scheme）：
       · 对象键按 UTF-16 码元升序（JS 字符串默认排序即是）
       · 无多余空白
       · 数字用 ECMAScript 的 Number::toString（JSON.stringify 即是）
       · 字符串用 JSON 最短转义（JSON.stringify 即是）
     ====================================================================== */

  function canonicalize(value) {
    if (value === null) return "null";

    const t = typeof value;

    if (t === "boolean") return value ? "true" : "false";

    if (t === "number") {
      if (!Number.isFinite(value)) {
        throw new Error("规格中不允许 NaN 或 Infinity");
      }
      return JSON.stringify(value);
    }

    if (t === "string") return JSON.stringify(value);

    if (Array.isArray(value)) {
      return "[" + value.map(canonicalize).join(",") + "]";
    }

    if (t === "object") {
      const keys = Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort();
      return (
        "{" +
        keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") +
        "}"
      );
    }

    throw new Error("不可序列化的类型：" + t);
  }

  /// 计算上链用的 specHash。keccak 由调用方提供（Node 与浏览器都能拿到 ethers）
  function hash(doc, keccak256, toUtf8Bytes) {
    const k = keccak256 || (typeof ethers !== "undefined" && ethers.keccak256);
    const u = toUtf8Bytes || (typeof ethers !== "undefined" && ethers.toUtf8Bytes);
    if (!k || !u) {
      throw new Error("需要传入 keccak256 与 toUtf8Bytes，或在全局提供 ethers");
    }
    return k(u(canonicalize(doc)));
  }

  /* ======================================================================
     2. 受限 Schema 方言

     只支持下面这些关键字。**遇到未知关键字直接报错，不静默忽略**——
     静默忽略会让人以为 oneOf 生效了，实际上没有，这比报错危险得多。

     不支持 $ref / oneOf / anyOf / allOf / not 是有意的：
     这份格式要让各种语言的 Agent 都能正确实现，小而一致胜过大而各异。
     ====================================================================== */

  const COMMON_KEYWORDS = ["type", "enum", "description"];

  const KEYWORDS_BY_TYPE = {
    object: ["properties", "required", "additionalProperties"],
    array: ["items", "minItems", "maxItems"],
    string: ["pattern", "minLength", "maxLength", "format"],
    number: ["minimum", "maximum"],
    integer: ["minimum", "maximum"],
    boolean: [],
  };

  const TYPES = Object.keys(KEYWORDS_BY_TYPE);

  /// 面向本领域的几个格式，比让每个人自己写正则可靠
  const FORMATS = {
    address: {
      test: (v) => /^0x[a-fA-F0-9]{40}$/.test(v),
      hint: "必须是 0x 开头的 40 位十六进制地址",
    },
    txhash: {
      test: (v) => /^0x[a-fA-F0-9]{64}$/.test(v),
      hint: "必须是 0x 开头的 64 位十六进制交易哈希",
    },
    uri: {
      test: (v) => /^(https?|ipfs|ar):\/\/.+/.test(v),
      hint: "必须是 http(s):// 、 ipfs:// 或 ar:// 开头的 URI",
    },
    "date-time": {
      test: (v) => !Number.isNaN(Date.parse(v)),
      hint: "必须是可解析的时间字符串",
    },
  };

  const MAX_PATTERN_LEN = 200;
  const MAX_SCHEMA_DEPTH = 8;

  /// 校验一份 schema 本身是否落在方言内
  function validateDialect(schema, path, errors, depth) {
    path = path || "$";
    depth = depth || 0;

    if (depth > MAX_SCHEMA_DEPTH) {
      errors.push(path + "：schema 嵌套超过 " + MAX_SCHEMA_DEPTH + " 层");
      return;
    }
    if (!isPlainObject(schema)) {
      errors.push(path + "：schema 必须是对象");
      return;
    }

    const type = schema.type;
    if (typeof type !== "string" || TYPES.indexOf(type) === -1) {
      errors.push(path + "：type 必须是 " + TYPES.join(" / ") + " 之一");
      return;
    }

    const allowed = COMMON_KEYWORDS.concat(KEYWORDS_BY_TYPE[type]);
    for (const key of Object.keys(schema)) {
      if (allowed.indexOf(key) === -1) {
        errors.push(
          path + "：不支持的关键字 " + JSON.stringify(key) +
          "（type=" + type + " 允许：" + allowed.join(", ") + "）"
        );
      }
    }

    if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
      errors.push(path + ".enum：必须是数组");
    }

    if (type === "object") {
      if (schema.properties !== undefined) {
        if (!isPlainObject(schema.properties)) {
          errors.push(path + ".properties：必须是对象");
        } else {
          for (const k of Object.keys(schema.properties)) {
            validateDialect(schema.properties[k], path + "." + k, errors, depth + 1);
          }
        }
      }
      if (schema.required !== undefined) {
        if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== "string")) {
          errors.push(path + ".required：必须是字符串数组");
        } else if (isPlainObject(schema.properties)) {
          for (const r of schema.required) {
            if (!(r in schema.properties)) {
              errors.push(path + ".required：" + JSON.stringify(r) + " 不在 properties 里");
            }
          }
        }
      }
    }

    if (type === "array") {
      if (schema.items === undefined) {
        errors.push(path + "：array 必须声明 items");
      } else {
        validateDialect(schema.items, path + "[]", errors, depth + 1);
      }
    }

    if (type === "string" && schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string" || schema.pattern.length > MAX_PATTERN_LEN) {
        errors.push(path + ".pattern：必须是长度不超过 " + MAX_PATTERN_LEN + " 的字符串");
      } else {
        try {
          new RegExp(schema.pattern);
        } catch (e) {
          errors.push(path + ".pattern：不是合法正则");
        }
      }
    }

    if (type === "string" && schema.format !== undefined) {
      if (!FORMATS[schema.format]) {
        errors.push(
          path + ".format：不支持的格式 " + JSON.stringify(schema.format) +
          "（支持：" + Object.keys(FORMATS).join(", ") + "）"
        );
      }
    }
  }

  /* ======================================================================
     3. 按 schema 校验取值
     ====================================================================== */

  function validateValue(schema, value, path, errors) {
    const type = schema.type;

    if (value === undefined || value === null) {
      errors.push(path + "：缺失");
      return;
    }

    switch (type) {
      case "object":
        if (!isPlainObject(value)) { errors.push(path + "：应为对象"); return; }
        break;
      case "array":
        if (!Array.isArray(value)) { errors.push(path + "：应为数组"); return; }
        break;
      case "string":
        if (typeof value !== "string") { errors.push(path + "：应为字符串"); return; }
        break;
      case "boolean":
        if (typeof value !== "boolean") { errors.push(path + "：应为布尔值"); return; }
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value)) {
          errors.push(path + "：应为整数"); return;
        }
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          errors.push(path + "：应为数字"); return;
        }
        break;
    }

    if (Array.isArray(schema.enum) && schema.enum.indexOf(value) === -1) {
      errors.push(path + "：必须是 " + schema.enum.map((v) => JSON.stringify(v)).join(" / ") + " 之一");
      return;
    }

    if (type === "object") {
      const required = schema.required || [];
      for (const r of required) {
        if (!(r in value) || value[r] === undefined || value[r] === null) {
          errors.push(path + "." + r + "：缺失");
        }
      }
      const props = schema.properties || {};
      for (const k of Object.keys(props)) {
        if (k in value && value[k] !== undefined && value[k] !== null) {
          validateValue(props[k], value[k], path + "." + k, errors);
        }
      }
      if (schema.additionalProperties === false) {
        for (const k of Object.keys(value)) {
          if (!(k in props)) errors.push(path + "." + k + "：不允许的额外字段");
        }
      }
    }

    if (type === "array") {
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(path + "：至少需要 " + schema.minItems + " 项，实际 " + value.length);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(path + "：最多 " + schema.maxItems + " 项，实际 " + value.length);
      }
      for (let i = 0; i < value.length; i++) {
        validateValue(schema.items, value[i], path + "[" + i + "]", errors);
      }
    }

    if (type === "string") {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(path + "：长度至少 " + schema.minLength);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(path + "：长度最多 " + schema.maxLength);
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
        errors.push(path + "：不匹配 " + schema.pattern);
      }
      if (schema.format !== undefined && FORMATS[schema.format] && !FORMATS[schema.format].test(value)) {
        errors.push(path + "：" + FORMATS[schema.format].hint);
      }
    }

    if (type === "number" || type === "integer") {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(path + "：不得小于 " + schema.minimum);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(path + "：不得大于 " + schema.maximum);
      }
    }
  }

  /* ======================================================================
     4. 规格文档本身的校验
     ====================================================================== */

  const CAPABILITY_RE = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/;

  const LIMITS = {
    title: 80,
    summary: 280,
    criterion: 300,
    criteriaMax: 12,
    rejectionsMax: 12,
    samplesMax: 5,
  };

  function validateSpec(doc, options) {
    const errors = [];
    const warnings = [];
    const known = (options && options.knownCapabilities) || null;

    if (!isPlainObject(doc)) {
      return { ok: false, errors: ["规格必须是一个 JSON 对象"], warnings: [] };
    }

    if (doc.version !== VERSION) {
      errors.push("version：必须是 " + VERSION + "，实际 " + JSON.stringify(doc.version));
    }

    // capability
    if (typeof doc.capability !== "string" || !CAPABILITY_RE.test(doc.capability)) {
      errors.push("capability：必须是点分小写标识，例如 contract.audit.owner-privileges");
    } else if (known && known.indexOf(doc.capability) === -1) {
      // 分类表是发现层的便利，不是准入门槛。表外的能力只提醒，不拒绝——
      // 否则「挂牌即模板，分类由市场长出来」就不成立了
      warnings.push(
        "capability：" + doc.capability + " 不在已知分类表内，检索时可能不易被发现"
      );
    }

    requireString(doc, "title", 1, LIMITS.title, errors);
    requireString(doc, "summary", 1, LIMITS.summary, errors);

    // input / output
    for (const field of ["input", "output"]) {
      const s = doc[field];
      if (!isPlainObject(s)) {
        errors.push(field + "：必须是一份 schema 对象");
        continue;
      }
      if (s.type !== "object") {
        errors.push(field + "：顶层 type 必须是 object");
      }
      validateDialect(s, field, errors, 0);
    }

    // acceptanceCriteria —— 争议裁决完全依赖它
    if (!Array.isArray(doc.acceptanceCriteria) || doc.acceptanceCriteria.length === 0) {
      errors.push("acceptanceCriteria：至少要写一条，争议裁决完全依赖它");
    } else {
      if (doc.acceptanceCriteria.length > LIMITS.criteriaMax) {
        errors.push("acceptanceCriteria：最多 " + LIMITS.criteriaMax + " 条");
      }
      doc.acceptanceCriteria.forEach((c, i) => {
        if (typeof c !== "string" || c.trim().length === 0) {
          errors.push("acceptanceCriteria[" + i + "]：必须是非空字符串");
        } else if (c.length > LIMITS.criterion) {
          errors.push("acceptanceCriteria[" + i + "]：不超过 " + LIMITS.criterion + " 字");
        }
      });
    }

    // rejections（可选但强烈建议）
    if (doc.rejections !== undefined) {
      if (!Array.isArray(doc.rejections) || doc.rejections.length > LIMITS.rejectionsMax) {
        errors.push("rejections：必须是不超过 " + LIMITS.rejectionsMax + " 项的数组");
      } else if (doc.rejections.some((r) => typeof r !== "string" || !r.trim())) {
        errors.push("rejections：每一项都必须是非空字符串");
      }
    } else {
      warnings.push(
        "rejections：建议写明不接受的情况。标准含糊时陪审团倾向判给服务方，" +
        "把话说清楚对发布方自己有利"
      );
    }

    // turnaround
    if (doc.turnaround !== undefined) {
      if (!Number.isInteger(doc.turnaround) || doc.turnaround <= 0) {
        errors.push("turnaround：必须是正整数秒数");
      }
    }

    // samples
    if (doc.samples !== undefined) {
      if (!Array.isArray(doc.samples) || doc.samples.length > LIMITS.samplesMax) {
        errors.push("samples：必须是不超过 " + LIMITS.samplesMax + " 项的数组");
      } else {
        doc.samples.forEach((s, i) => {
          if (typeof s !== "string" || !FORMATS.uri.test(s)) {
            errors.push("samples[" + i + "]：" + FORMATS.uri.hint);
          }
        });
      }
    } else {
      warnings.push("samples：建议提供样例输出，买方付钱前能先评估");
    }

    // 未知顶层字段
    const allowedTop = [
      "version", "capability", "title", "summary",
      "input", "output", "acceptanceCriteria", "rejections",
      "turnaround", "samples",
    ];
    for (const k of Object.keys(doc)) {
      if (allowedTop.indexOf(k) === -1) {
        warnings.push("未知顶层字段 " + JSON.stringify(k) + "，会被忽略");
      }
    }

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  /* ======================================================================
     5. 输入 / 交付物校验
     ====================================================================== */

  /// 买方 Agent 在付钱之前自检参数
  function validateInput(spec, input) {
    return runAgainst(spec, "input", input);
  }

  /// 争议裁决的客观前置：交付物符不符合声明的 output schema 是事实，不是品味。
  /// 陪审团只需要处理「符合结构但质量有争议」的那一半
  function validateOutput(spec, output) {
    return runAgainst(spec, "output", output);
  }

  function runAgainst(spec, field, value) {
    if (!isPlainObject(spec) || !isPlainObject(spec[field])) {
      return { ok: false, errors: ["规格缺少合法的 " + field + " schema"], warnings: [] };
    }
    const dialectErrors = [];
    validateDialect(spec[field], field, dialectErrors, 0);
    if (dialectErrors.length) {
      return { ok: false, errors: dialectErrors, warnings: [] };
    }
    const errors = [];
    validateValue(spec[field], value, field, errors);
    return { ok: errors.length === 0, errors: errors, warnings: [] };
  }

  /* ======================================================================
     工具
     ====================================================================== */

  function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  function requireString(doc, key, min, max, errors) {
    const v = doc[key];
    if (typeof v !== "string" || v.trim().length < min) {
      errors.push(key + "：必须是非空字符串");
    } else if (v.length > max) {
      errors.push(key + "：不超过 " + max + " 字");
    }
  }

  return {
    VERSION: VERSION,
    FORMATS: Object.keys(FORMATS),
    canonicalize: canonicalize,
    hash: hash,
    validateSpec: validateSpec,
    validateDialect: function (schema) {
      const errors = [];
      validateDialect(schema, "$", errors, 0);
      return { ok: errors.length === 0, errors: errors, warnings: [] };
    },
    validateInput: validateInput,
    validateOutput: validateOutput,
  };
});
