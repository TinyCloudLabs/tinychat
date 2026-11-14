import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { REQUEST_LOG_ROUTE_TEMPLATES } from "../request-log-routes.js";

// TC-3031: the shipped `route_template` is a closed list. This reads the backend source with the TypeScript compiler
// and derives every template the request record can name, the way routeTemplate() in request-context.ts builds it:
// a string mount on `app` plus the router's terminal path ("/" names the mount alone); a route registered directly on
// `app`, a path-less mount or a nested `router.use("/sub", ...)` names the terminal path alone. Every registration is
// counted, whatever flag guards it. A path, mount or router the scanner cannot resolve to a literal fails the test.

const backendRoot = resolve(import.meta.dir, "../..");
const repoRoot = resolve(backendRoot, "..");
const ROUTE_METHODS: Record<string, true> = { all: true, get: true, post: true, put: true, patch: true, delete: true, options: true, head: true };
/** The contract's route template shape: at most 96 characters. A registered template must fit it to be listed. */
const TEMPLATE_SHAPE = /^\/[A-Za-z0-9_.:*/-]{0,95}$/;

type FunctionWithBody = ts.FunctionLikeDeclaration & { body: ts.Node };

function scanRegisteredTemplates(): { templates: Set<string>; errors: string[] } {
  const config = ts.readConfigFile(resolve(backendRoot, "tsconfig.json"), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, backendRoot).options;
  const entry = resolve(backendRoot, "src/index.ts");
  const program = ts.createProgram([entry], { ...options, noEmit: true });
  const checker = program.getTypeChecker();
  const templates = new Set<string>();
  const errors: string[] = [];
  const scanned = new Set<string>();

  const where = (node: ts.Node) => {
    const file = node.getSourceFile();
    return `${relative(backendRoot, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  };
  const fail = (node: ts.Node, message: string) => errors.push(`${where(node)}: ${message}: ${node.getText().slice(0, 120)}`);

  const literal = (node: ts.Expression): string | undefined => {
    const type = checker.getTypeAtLocation(node);
    return type.isStringLiteral() ? type.value : undefined;
  };
  const isRouter = (node: ts.Expression) => {
    const type = checker.getTypeAtLocation(node);
    return type.getSymbol()?.getName() === "Router" || type.aliasSymbol?.getName() === "Router";
  };
  /** A mount/route path argument, as opposed to a handler: handlers (and routers) are callable. */
  const isPath = (node: ts.Expression) => checker.getTypeAtLocation(node).getCallSignatures().length === 0;

  const declarationOf = (node: ts.Expression): ts.Declaration | undefined => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  };
  const isLibrary = (declaration: ts.Declaration | undefined) =>
    !declaration || declaration.getSourceFile().isDeclarationFile || declaration.getSourceFile().fileName.includes("/node_modules/");
  /** The source function a call expression runs, or undefined when it is not one of the backend's own functions. */
  const functionOf = (callee: ts.Expression): FunctionWithBody | undefined => {
    const declaration = declarationOf(callee);
    if (isLibrary(declaration)) return undefined;
    if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body) return declaration as FunctionWithBody;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
      return declaration.initializer as FunctionWithBody;
    }
    return undefined;
  };
  const enclosingFunction = (node: ts.Node): ts.Node => {
    let current = node.parent;
    while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
    return current;
  };

  const add = (node: ts.Node, mount: string | undefined, terminal: string) => {
    const route = mount === undefined ? terminal : mount + (terminal === "/" ? "" : terminal);
    if (route.length > 256) return fail(node, "template longer than routeTemplate() names (it would ship as unmatched)");
    templates.add(route);
  };

  /** A router handed to a mount: scan the routes it registers, with the mount that routeTemplate() would prefix. */
  const scanRouterExpression = (node: ts.Expression, mount: string | undefined) => {
    if (ts.isCallExpression(node)) {
      const factory = functionOf(node.expression);
      if (!factory) return fail(node, "router built by a call the scanner cannot follow");
      return scanRouterFactory(factory, mount);
    }
    if (ts.isIdentifier(node)) {
      const declaration = declarationOf(node);
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isCallExpression(declaration.initializer)) {
        const factory = functionOf(declaration.initializer.expression);
        if (factory) return scanRouterFactory(factory, mount);
        if (isLibrary(declarationOf(declaration.initializer.expression))) {
          return scanBody(enclosingFunction(declaration), new Set([node.text]), "router", mount);
        }
      }
    }
    fail(node, "router the scanner cannot resolve");
  };

  const scanRouterFactory = (factory: FunctionWithBody, mount: string | undefined) => {
    const key = `${factory.getSourceFile().fileName}:${factory.pos}:${mount ?? ""}`;
    if (scanned.has(key)) return;
    scanned.add(key);
    const routers = new Set<string>();
    let found = false;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
        && isRouter(node.initializer)) {
        routers.add(node.name.text);
        found = true;
        const nested = functionOf(node.initializer.expression);
        if (nested) scanRouterFactory(nested, mount);
      } else if (ts.isReturnStatement(node) && node.expression && ts.isCallExpression(node.expression) && isRouter(node.expression)) {
        found = true;
        scanRouterExpression(node.expression, mount);
      }
      if (!ts.isFunctionLike(node) || node === factory) ts.forEachChild(node, visit);
    };
    visit(factory);
    if (!found) return fail(factory, "router factory without a recognisable Router()");
    scanBody(factory.body, routers, "router", mount);
  };

  /** Registrations on `holders` (the app or a router) anywhere in `body`, including helpers they are passed to. */
  const scanBody = (body: ts.Node, holders: Set<string>, kind: "app" | "router", mount: string | undefined) => {
    const isHolder = (node: ts.Node): node is ts.Identifier => ts.isIdentifier(node) && holders.has(node.text);
    const visit = (node: ts.Node) => {
      if (ts.isElementAccessExpression(node) && isHolder(node.expression)) fail(node, "computed registration");
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) && isHolder(callee.expression)) {
          registration(node, callee.name.text, kind, mount);
        } else {
          node.arguments.forEach((argument, index) => {
            if (!isHolder(argument)) return;
            // The app or a router handed to a helper: follow it into the helper's matching parameter.
            const helper = functionOf(callee);
            if (!helper) {
              if (isLibrary(declarationOf(callee))) return;
              return fail(node, `${kind} passed to a call the scanner cannot follow`);
            }
            const parameter = helper.parameters[index];
            if (!parameter || !ts.isIdentifier(parameter.name)) return fail(node, `${kind} passed to an unnamed parameter`);
            scanBody(helper.body, new Set([parameter.name.text]), kind, mount);
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
  };

  const registration = (call: ts.CallExpression, method: string, kind: "app" | "router", mount: string | undefined) => {
    const [first, ...rest] = call.arguments;
    if (Object.hasOwn(ROUTE_METHODS, method) || method === "route") {
      // app.get("setting") reads an app setting; it registers nothing.
      if (kind === "app" && method === "get" && call.arguments.length === 1) return;
      const path = first && literal(first);
      if (path === undefined) return fail(call, "route path is not a string literal");
      return add(call, kind === "app" ? undefined : mount, path);
    }
    if (method !== "use") return;
    const pathGiven = first !== undefined && isPath(first);
    const path = pathGiven ? literal(first) : undefined;
    for (const handler of pathGiven ? rest : call.arguments) {
      if (!isRouter(handler)) continue;
      if (pathGiven && path === undefined) return fail(call, "router mounted on a non-literal path");
      // Only a string mount on the app is recorded; a nested router's baseUrl never matches it.
      const childMount = kind === "app" ? (path === undefined || path === "/" ? undefined : path) : (pathGiven ? undefined : mount);
      scanRouterExpression(handler, childMount);
    }
  };

  const index = program.getSourceFile(entry)!;
  const apps: ts.VariableDeclaration[] = [];
  const findApp = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "app") apps.push(node);
    ts.forEachChild(node, findApp);
  };
  findApp(index);
  if (apps.length !== 1) errors.push(`src/index.ts: expected exactly one \`app\` declaration, found ${apps.length}`);
  else scanBody(enclosingFunction(apps[0]), new Set(["app"]), "app", undefined);
  return { templates, errors };
}

describe("TC-3031 request-log route templates", () => {
  const scan = scanRegisteredTemplates();
  const listed = REQUEST_LOG_ROUTE_TEMPLATES.filter(template => template !== "unmatched");

  test("the scanner resolves every registration in the backend", () => {
    expect(scan.errors).toEqual([]);
    expect(scan.templates.size).toBeGreaterThan(50);
  });

  test("every template the backend registers fits the contract and is in the list", () => {
    const misfits = [...scan.templates].filter(template => !TEMPLATE_SHAPE.test(template)).sort();
    expect(misfits, "registered templates longer than 96 characters or off the contract shape; shorten the route or widen the contract").toEqual([]);
    expect([...scan.templates].filter(template => !listed.includes(template)).sort()).toEqual([]);
  });

  test("every listed template is registered by the backend", () => {
    expect(listed.filter(template => !scan.templates.has(template))).toEqual([]);
  });

  test("the list is sorted, unique, ends with unmatched and fits the contract shape", () => {
    expect([...REQUEST_LOG_ROUTE_TEMPLATES]).toEqual([...new Set(REQUEST_LOG_ROUTE_TEMPLATES)].sort());
    expect(REQUEST_LOG_ROUTE_TEMPLATES.at(-1)).toBe("unmatched");
    for (const template of listed) expect(template).toMatch(TEMPLATE_SHAPE);
  });

  test("fields.json, vector.yaml and the Compose copy carry exactly this list", () => {
    const fields = JSON.parse(readFileSync(resolve(repoRoot, "log-shipper/fields.json"), "utf8"));
    expect(fields.services["tinychat-backend"].fields.route_template).toEqual({ type: "enum", values: [...REQUEST_LOG_ROUTE_TEMPLATES] });
    const check = `if !includes(${JSON.stringify(REQUEST_LOG_ROUTE_TEMPLATES).replaceAll(",", ", ")}, route) { route = "unmatched" }`;
    expect(readFileSync(resolve(repoRoot, "log-shipper/vector.yaml"), "utf8")).toContain(`\n          ${check}\n`);
    // log-shipper.test.ts pins the Compose copy to vector.yaml with every $ doubled; no template contains a $.
    expect(readFileSync(resolve(repoRoot, "docker-compose.phala.yml"), "utf8")).toContain(`\n                  ${check}\n`);
  });
});
