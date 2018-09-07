const { inspect } = require("util");
const generateJs = require("@babel/generator").default;
const template = require("@babel/template").default;
const t = require("@babel/types");
const { mangle } = require("./utils");

const id = x => t.identifier(x);

const fresh = {
  current: 1,
  next(name = "ref") {
    return `$$${name}_${this.current++}`;
  }
};

function isArray(a) {
  return t.callExpression(t.memberExpression(id("Array"), id("isArray")), [a]);
}

function isNull(a) {
  return t.binaryExpression("===", a, t.nullLiteral());
}

function isNone(a) {
  return t.binaryExpression("==", a, t.nullLiteral());
}

function isntNone(a) {
  return t.binaryExpression("!=", a, t.nullLiteral());
}

function isntNull(a) {
  return t.binaryExpression("!==", a, t.nullLiteral());
}

function typeOf(a) {
  return t.unaryExpression("typeof", a, true);
}

function isObject(a) {
  return t.logicalExpression(
    "&&",
    isntNull(a),
    t.binaryExpression("===", typeOf(a), t.stringLiteral("object"))
  );
}

function hasLength(a, op, i) {
  return t.binaryExpression(op, t.memberExpression(a, id("length")), i);
}

function defConst(name, value) {
  return t.variableDeclaration("const", [t.variableDeclarator(name, value)]);
}

function at(obj, i) {
  return t.memberExpression(obj, i, true);
}

function send(obj, message, args) {
  return t.callExpression(t.memberExpression(obj, id(message)), args);
}

function $assert(expr, message) {
  return t.ifStatement(
    t.unaryExpression("!", expr),
    t.throwStatement(t.callExpression(id("Error"), [t.stringLiteral(message)]))
  );
}

function flatmap(xs, f) {
  return xs.map(f).reduce((a, b) => a.concat(b), []);
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

    case "IfStatement": {
      const fixAlternate = node => {
        switch (node.type) {
          case "ElseIf":
            return {
              type: "ElseIf",
              if: fixReturns([node.if][0])
            };

          case "Else":
            return {
              type: "Else",
              block: fixReturns(node.block)
            };

          default:
            throw new Error(`Unknown node ${node.type}`);
        }
      };

      return [
        ...initial,
        {
          type: "IfStatement",
          test: last.test,
          block: fixReturns(last.block),
          alternate: last.alternate ? fixAlternate(last.alternate) : null
        }
      ];
    }

    case "MatchStatement": {
      const fixCase = matchCase => {
        return Object.assign({}, matchCase, {
          block: fixReturns(matchCase.block)
        });
      };

      return [
        ...initial,
        {
          type: "MatchStatement",
          match: {
            type: "Match",
            value: last.match.value,
            cases: last.match.cases.map(fixCase)
          }
        }
      ];
    }

    case "LetStatement":
    case "AssertStatement":
    case "ForeachStatement":
    case "WhileStatement":
    case "UntilStatement":
    case "ForStatement":
    case "RepeatStatement":
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

    case "DefaultBinding":
      return t.importDefaultSpecifier(id(node.name));

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

    case "ForeachStatement":
      return t.forOfStatement(
        id(node.name),
        compile(node.iterator),
        t.blockStatement(node.block.map(compile))
      );

    case "WhileStatement":
      return t.whileStatement(
        compile(node.predicate),
        t.blockStatement(node.block.map(compile))
      );

    case "UntilStatement":
      return t.doWhileStatement(
        compile(node.predicate),
        t.blockStatement(node.block.map(compile))
      );

    case "ForStatement":
      return t.forStatement(
        t.variableDeclaration("let", [
          t.variableDeclarator(id(node.name), compile(node.start))
        ]),
        t.binaryExpression("<=", id(node.name), compile(node.end)),
        t.assignmentExpression("+=", id(name), compile(node.by))
      );

    case "RepeatStatement":
      return t.whileStatement(
        t.booleanLiteral(true),
        t.blockStatement(node.block.map(compile))
      );

    case "IfStatement": {
      const compileIf = node => {
        return t.ifStatement(
          compile(node.test),
          t.blockStatement(node.block.map(compile)),
          alternate ? compileAlternate(alternate) : null
        );
      };
      const compileAlternate = node => {
        switch (node.type) {
          case "ElseIf":
            return compileIf(node.if);

          case "Else":
            return t.blockStatement(node.block.map(compile));

          default:
            throw new Error(`Unknown node ${node.type}`);
        }
      };

      return compileIf(node);
    }

    case "MatchStatement":
      return t.blockStatement(compileMatch(node.match));

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

    case "UnaryExpression":
      return t.callExpression(id(mangle(node.operator)), [
        compile(node.argument)
      ]);

    case "CallExpression":
      return t.callExpression(compile(node.callee), node.params.map(compile));

    case "MethodCallExpression":
      return t.callExpression(
        t.memberExpression(compile(node.object), id(node.method)),
        node.params.map(compile)
      );

    case "AtPutExpression":
      return t.callExpression(id(mangle("[]<-")), [
        compile(node.object),
        compile(node.key),
        compile(node.value)
      ]);

    case "UpdateExpression":
      return t.assignmentExpression(
        "=",
        compile(node.location),
        compile(node.value)
      );

    case "AtExpression":
      return t.callExpression(id(mangle("[]")), [
        compile(node.object),
        compile(node.key)
      ]);

    case "GetExpression":
      return t.memberExpression(compile(node.object), id(node.name));

    case "NewExpression":
      return t.newExpression(
        compile(node.constructor),
        node.params.map(compile)
      );

    case "SuperExpression":
      return id("super");

    case "VariableExpression":
      return t.identifier(node.name);

    case "LiteralExpression":
      return compileLiteral(node.literal);

    case "ArrayExpression":
      return t.arrayExpression(node.items.map(compile));

    case "ObjectExpression":
      return t.objectExpression(
        node.pairs.map(({ key, expression }) => {
          return t.objectProperty(id(key), compile(expression));
        })
      );

    case "FunctionExpression": {
      if (node.kind === "generator") {
        return t.functionExpression(
          null,
          node.params.map(id),
          t.blockStatement(fixReturns(node.block).map(compile)),
          true
        );
      } else {
        return t.arrowFunctionExpression(
          node.params.map(id),
          t.blockStatement(fixReturns(node.block).map(compile)),
          node.kind === "async"
        );
      }
    }

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
          compileLiteral(node.id)
        )
      ];

    case "Exposing":
      return [
        t.importDeclaration(node.bindings.map(compile), compileLiteral(node.id))
      ];

    default:
      throw new Error(`Unknown import type ${node.tag}`);
  }
}

function compileClass(node) {
  const isData = node.tag === "Data";
  const {
    name,
    params,
    superclass,
    fields,
    constructor,
    members
  } = node.declaration;

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
  const constructorPrelude = [
    ...params.map(x => {
      return t.expressionStatement(
        t.assignmentExpression("=", field(x), id(x))
      );
    }),
    ...fields.map(x => {
      return t.expressionStatement(
        t.assignmentExpression("=", field(x.name), compile(x.value))
      );
    })
  ];

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

  const unpackPrelude = [
    ...params.map(x => defConst(id(x), field(x))),
    ...fields.map(x => defConst(id(x.name), field(x.name)))
  ];

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

  const genMethods = isData
    ? [
        t.classMethod(
          "method",
          id("unapply"),
          [id("object")],
          t.blockStatement([
            t.ifStatement(
              t.binaryExpression("instanceof", id("object"), id(name)),
              t.blockStatement([
                t.returnStatement(t.arrayExpression(params.map(field)))
              ]),
              t.blockStatement([t.returnStatement(t.nullLiteral())])
            )
          ])
        )
      ]
    : [];

  return [
    t.exportNamedDeclaration(
      t.classDeclaration(
        id(name),
        superclass ? compile(superclass.constructor) : null,
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
          ...genMethods,
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

function compileLiteral(node) {
  switch (node.type) {
    case "String":
      return t.stringLiteral(node.value);

    case "Integer":
      return t.numericLiteral(Number(`${node.sign || ""}${node.digits}`));

    case "Decimal":
      return t.numericLiteral(
        Number(`${node.sign || ""}${node.integer}.${node.decimal}`)
      );

    case "Boolean":
      return t.booleanLiteral(node.value);

    default:
      throw new Error(`Unknown node type ${node.type}`);
  }
}

function compileMatch(match) {
  const bind = id(fresh.next());

  const compilePattern = (bind, pattern) => {
    switch (pattern.tag) {
      case "Literal":
        return e => [
          t.ifStatement(
            t.binaryExpression("===", bind, compileLiteral(pattern.literal)),
            e
          )
        ];

      case "Array": {
        const pat = pattern.pattern;
        const isValidArray = (a, op, i) =>
          t.logicalExpression(
            "&&",
            isArray(a),
            hasLength(a, op, t.numericLiteral(i))
          );

        switch (pat.tag) {
          case "Spread": {
            const spreadBind = id(fresh.next());
            return e => [
              t.ifStatement(
                isValidArray(bind, ">=", pat.items.length),
                pat.items.reduceRight(
                  (e, newPattern, i) => {
                    const newBind = id(fresh.next());
                    return t.blockStatement([
                      defConst(newBind, at(bind, t.numericLiteral(i))),
                      ...compilePattern(newBind, newPattern)(e)
                    ]);
                  },
                  /**/
                  t.blockStatement([
                    defConst(
                      spreadBind,
                      send(bind, "slice", [t.numericLiteral(pat.items.length)])
                    ),
                    ...compilePattern(spreadBind, pat.spread)(e)
                  ])
                )
              )
            ];
          }

          case "Regular": {
            return e => [
              t.ifStatement(
                isValidArray(bind, "===", pat.items.length),
                pat.items.reduceRight((e, newPattern, i) => {
                  const newBind = id(fresh.next());
                  return t.blockStatement([
                    defConst(newBind, at(bind, t.numericLiteral(i))),
                    ...compilePattern(newBind, newPattern)(e)
                  ]);
                }, e)
              )
            ];
          }

          default:
            throw new Error(`Unknown array pattern ${pat.tag}`);
        }
      }

      case "Object": {
        return e => [
          t.ifStatement(
            isObject(bind),
            pattern.pairs.reduceRight((e, pair) => {
              const newBind = id(fresh.next());
              return t.blockStatement([
                defConst(newBind, at(bind, t.stringLiteral(pair.name))),
                ...compilePattern(newBind, pair.pattern)(e)
              ]);
            }, e)
          )
        ];
      }

      case "Extractor": {
        return e => {
          const unapplied = id(fresh.next());
          return [
            defConst(
              unapplied,
              send(compile(pattern.object), "unapply", [bind])
            ),
            t.ifStatement(
              isntNone(unapplied),
              t.blockStatement([
                $assert(
                  isArray(unapplied),
                  "unapply() must return null or an array"
                ),
                pattern.patterns.reduceRight((e, newPattern, i) => {
                  const newBind = id(fresh.next());
                  return t.blockStatement([
                    defConst(newBind, at(unapplied, t.numericLiteral(i))),
                    ...compilePattern(newBind, newPattern)(e)
                  ]);
                }, e)
              ])
            )
          ];
        };
      }

      case "Bind":
        return e => [
          t.variableDeclaration("const", [
            t.variableDeclarator(id(pattern.name), bind)
          ]),
          e
        ];

      default:
        throw new Error(`Unknown pattern tag ${pattern.tag}`);
    }
  };

  const compileCase = bind => matchCase => {
    switch (matchCase.tag) {
      case "When":
        return t.blockStatement(
          compilePattern(bind, matchCase.pattern)(
            t.ifStatement(
              compile(matchCase.predicate),
              t.blockStatement(matchCase.block.map(compile))
            )
          )
        );

      case "Case":
        return t.blockStatement(
          compilePattern(bind, matchCase.pattern)(
            t.blockStatement(matchCase.block.map(compile))
          )
        );

      case "Default":
        return t.blockStatement(matchCase.block.map(compile));

      default:
        throw new Error(`Unknown match case tag ${matchCase.tag}`);
    }
  };

  return [
    t.variableDeclaration("const", [
      t.variableDeclarator(bind, compile(match.value))
    ]),
    ...match.cases.map(compileCase(bind))
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
  compileLiteral,
  generate
};
