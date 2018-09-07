function mangle(name) {
  switch (name) {
    case "===":
      return "$equals";

    case "=/=":
      return "$notEquals";

    case "==>":
      return "$imply";

    case ">=":
      return "$gte";

    case ">>":
      return "$composeRight";

    case ">":
      return "$gt";

    case "<=":
      return "$lte";

    case "<<":
      return "$composeLeft";

    case "<":
      return "$lt";

    case "++":
      return "$concat";

    case "+":
      return "$plus";

    case "-":
      return "$minus";

    case "**":
      return "$power";

    case "*":
      return "$multiply";

    case "/":
      return "$divide";

    case "and":
    case "or":
    case "not":
      return `$${name}`;

    case "[]":
      return `$at`;

    case "[]<-":
      return `$atPut`;

    default:
      throw new Error(`Unknown operator ${name}`);
  }
}

module.exports = { mangle };
