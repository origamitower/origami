const { inspect } = require("util");
const generateJs = require("@babel/generator").default;
const template = require("@babel/template").default;
const t = require("@babel/types");

const id = x => t.identifier(x);

function flatmap(xs, f) {
  return xs.map(f).reduce((a, b) => a.concat(b), []);
}

function mangle(name) {
  switch (name) {
    case "===":
      return "origami$equals";

    case "=/=":
      return "origami$notEquals";

    case "==>":
      return "origami$imply";

    case ">=":
      return "origami$gte";

    case ">>":
      return "origami$composeRight";

    case ">":
      return "origami$gt";

    case "<=":
      return "origami$lte";

    case "<<":
      return "origami$composeLeft";

    case "<":
      return "origami$lt";

    case "++":
      return "origami$concat";

    case "+":
      return "origami$plus";

    case "-":
      return "origami$minus";

    case "**":
      return "origami$power";

    case "*":
      return "origami$multiply";

    case "/":
      return "origami$divide";

    case "and":
    case "or":
    case "not":
      return `origami$${name}`;

    default:
      throw new Error(`Unknown operator ${name}`);
  }
}

function fixReturns(block) {
  if (block.length === 0) {
    return [];
  }

  const initial = block.slice(0, -1);
  const last = block[block.length - 1];

  switch (last.type) {
    case "ExpressionStatement":
      return [
        ...initial,
        {
          type: "ReturnStatement",
          expression: last.expression
        }
      ];

    case "LetStatement":
    case "AssertStatement":
      return [...initial, last];

    default:
      throw new Error(`Unknown node type ${last.type}`);
  }
}

function compileModule(module) {
  return t.program(
    flatmap(module.definitions, compileDefinition),
    [],
    "module"
  );
}

function compileDefinition(node) {
  switch (node.type) {
    case "Import":
      return compileImport(node);

    case "Function":
      return compileFunction(node);

    case "Class":
      return compileClass(node);

    default:
      throw new Error(`Unknown node ${node.type}`);
  }
}

function compile(node) {
  switch (node.type) {
    case "Binding":
      return t.importSpecifier(id(node.alias), id(node.name));

    case "String":
      return t.stringLiteral(node.value);

    case "ExpressionStatement":
      return t.expressionStatement(compile(node.expression));

    case "LetStatement":
      return t.variableDeclaration(node.mutable ? "let" : "const", [
        t.variableDeclarator(id(node.name), compile(node.expression))
      ]);

    case "AssertStatement":
      return t.ifStatement(
        t.unaryExpression("!", compile(node.expression), true),
        t.blockStatement([
          t.throwStatement(
            t.newExpression(id("Error"), [
              t.stringLiteral(`Assertion failed: ${node.code}`)
            ])
          )
        ])
      );

    // Note: this node doesn't exist in the grammar, it's added by the ReturnLast pass
    case "ReturnStatement":
      return t.returnStatement(compile(node.expression));

    case "IfExpression":
      return t.conditionalExpression(
        compile(node.test),
        compile(node.consequent),
        compile(node.alternate)
      );

    case "PipeExpression":
      return t.callExpression(compile(node.right), [compile(node.left)]);

    case "AwaitExpression":
      return t.awaitExpression(compile(node.expression));

    case "YieldExpression":
      return t.yieldExpression(compile(node.expression), node.generator);

    case "BinaryExpression":
      return t.callExpression(id(mangle(node.operator)), [
        compile(node.left),
        compile(node.right)
      ]);

    case "VariableExpression":
      return t.identifier(node.name);

    case "LiteralExpression":
      return compile(node.literal);

    default:
      throw new Error(`Unknown node ${node.type}`);
  }
}

function compileImport(node) {
  switch (node.tag) {
    case "As":
      return [
        t.importDeclaration(
          [t.importNamespaceSpecifier(id(node.alias))],
          compile(node.id)
        )
      ];

    case "Exposing":
      return [
        t.importDeclaration(node.bindings.map(compile), compile(node.id))
      ];

    default:
      throw new Error(`Unknown import type ${node.tag}`);
  }
}

function compileClass(node) {
  const isData = node.tag === "Data";
  const { name, params, superclass, constructor, members } = node.declaration;

  const field = x => t.memberExpression(t.thisExpression(), id(`__${x}`));

  function compileMember(member) {
    const { type, self, name, block } = member.definition;
    const methodParams = member.definition.params;
    const functionKind = member.definition.kind;
    const methodKind =
      type === "MemberMethod"
        ? "method"
        : type === "MemberSetter"
          ? "set"
          : type === "MemberGetter"
            ? "get"
            : null;
    const realBlock = type === "MemberSetter" ? block : fixReturns(block);

    return {
      type: "ClassMethod",
      static: member.tag === "Static",
      key: id(name),
      computed: false,
      kind: methodKind,
      generator: functionKind === "generator",
      async: functionKind === "async",
      params: methodParams.map(id),
      body: t.blockStatement([
        ...unpackPrelude,
        t.variableDeclaration("const", [
          t.variableDeclarator(id(self), t.thisExpression())
        ]),
        ...realBlock.map(compile)
      ])
    };
  }

  // We always set all properties in the class
  const constructorPrelude = params.map(x => {
    return t.expressionStatement(t.assignmentExpression("=", field(x), id(x)));
  });

  const superPrelude = superclass
    ? [
        t.expressionStatement(
          t.callExpression(
            t.identifier("super"),
            superclass.params.map(compile)
          )
        )
      ]
    : [];

  const unpackPrelude = params.map(x => {
    return t.variableDeclaration("const", [
      t.variableDeclarator(id(x), field(x))
    ]);
  });

  const compiledMembers = members.map(compileMember);

  const genGetters = isData
    ? params.map(x => {
        return t.classMethod(
          "get",
          id(x),
          [],
          t.blockStatement([t.returnStatement(field(x))])
        );
      })
    : [];

  return [
    t.exportNamedDeclaration(
      t.classDeclaration(
        id(name),
        superclass ? compile(superclass.expression) : null,
        t.classBody([
          t.classMethod(
            "constructor",
            id("constructor"),
            params.map(x => id(x)),
            t.blockStatement([
              ...superPrelude,
              ...constructorPrelude,
              ...constructor.map(compile)
            ])
          ),
          ...genGetters,
          ...compiledMembers
        ])
      ),
      []
    )
  ];
}

function compileFunction(node) {
  const { name, params, kind } = node.signature;
  return [
    t.exportNamedDeclaration(
      t.functionDeclaration(
        id(name),
        params.map(x => id(x)),
        t.blockStatement(fixReturns(node.block).map(compile)),
        kind === "generator",
        kind === "async"
      ),
      []
    )
  ];
}

function generate(ast) {
  return generateJs(compileModule(ast));
}

module.exports = {
  compileModule,
  compile,
  compileDefinition,
  compileClass,
  compileFunction,
  compileImport,
  generate
};
