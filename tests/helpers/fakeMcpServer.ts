export interface RegisteredTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
  handler: (args: unknown, extra?: unknown) => unknown | Promise<unknown>;
}

export interface RegisteredPrompt {
  name: string;
  description?: string;
  argsSchema?: unknown;
  handler: (args?: unknown, extra?: unknown) => unknown | Promise<unknown>;
}

export interface RegisteredResource {
  name: string;
  uri: string;
  metadata?: unknown;
  handler: (uri?: URL, extra?: unknown) => unknown | Promise<unknown>;
}

function getLastArg<T>(args: unknown[]): T {
  return args.at(-1) as T;
}

export class FakeMcpServer {
  readonly server = {};
  readonly tools: RegisteredTool[] = [];
  readonly prompts: RegisteredPrompt[] = [];
  readonly resources: RegisteredResource[] = [];

  tool(...args: unknown[]): void {
    const [name] = args;
    const handler = getLastArg<RegisteredTool["handler"]>(args);
    const description = typeof args[1] === "string" ? args[1] : undefined;
    const inputSchema = args.length >= 4 ? args[2] : undefined;
    const annotations = args.length >= 5 ? args[3] : undefined;

    this.tools.push({
      name: String(name),
      description,
      inputSchema,
      annotations,
      handler,
    });
  }

  // A assinatura posicional de server.tool() esta depreciada no SDK; registerTool
  // recebe a configuracao em um objeto. O fake implementa as duas porque o fonte
  // esta em migracao -- e sem este metodo o teste passaria a nao medir nada.
  registerTool(name: unknown, config: unknown, handler: RegisteredTool["handler"]): void {
    const meta = (config ?? {}) as {
      description?: unknown;
      inputSchema?: unknown;
      annotations?: unknown;
    };

    this.tools.push({
      name: String(name),
      description: typeof meta.description === "string" ? meta.description : undefined,
      inputSchema: meta.inputSchema,
      annotations: meta.annotations,
      handler,
    });
  }

  prompt(...args: unknown[]): void {
    const [name] = args;
    const handler = getLastArg<RegisteredPrompt["handler"]>(args);
    const description = typeof args[1] === "string" ? args[1] : undefined;
    const argsSchema = args.length >= 4 ? args[2] : undefined;

    this.prompts.push({
      name: String(name),
      description,
      argsSchema,
      handler,
    });
  }

  resource(...args: unknown[]): void {
    const [name, uri] = args;
    const handler = getLastArg<RegisteredResource["handler"]>(args);
    const metadata = args.length >= 4 ? args[2] : undefined;

    this.resources.push({
      name: String(name),
      uri: String(uri),
      metadata,
      handler,
    });
  }

  getTool(name: string): RegisteredTool {
    const tool = this.tools.find((registeredTool) => registeredTool.name === name);
    if (!tool) {
      throw new Error(`Tool not registered: ${name}`);
    }
    return tool;
  }
}
