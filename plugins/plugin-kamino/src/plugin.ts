import type { Plugin } from '@elizaos/core';
import {
  type Action,
  type ActionResult,
  type GenerateTextParams,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type Provider,
  type ProviderResult,
  type RouteRequest,
  type RouteResponse,
  Service,
  type State,
  logger,
  type MessagePayload,
  type WorldPayload,
  EventType,
} from '@elizaos/core';
import { z } from 'zod';

/**
 * Defines the configuration schema for a plugin, including the validation rules for the plugin name.
 *
 * @type {import('zod').ZodObject<{ EXAMPLE_PLUGIN_VARIABLE: import('zod').ZodString }>}
 */
const configSchema = z.object({
  SOLANA_RPC_URL: z.string().min(1, 'Solana RPC URL is required'),
  SOLANA_PRIVATE_KEY: z.string().min(1, "Solana private key is required"),
});

/**
 * Example HelloWorld action
 * This demonstrates the simplest possible action structure
 */
/**
 * Action representing a hello world message.
 * @typedef {Object} Action
 * @property {string} name - The name of the action.
 * @property {string[]} similes - An array of related actions.
 * @property {string} description - A brief description of the action.
 * @property {Function} validate - Asynchronous function to validate the action.
 * @property {Function} handler - Asynchronous function to handle the action and generate a response.
 * @property {Object[]} examples - An array of example inputs and expected outputs for the action.
 */
const quickAction: Action = {
  name: 'QUICK_ACTION',
  similes: ['GREET', 'SAY_HELLO', 'HELLO_WORLD'],
  description: 'Responds with a simple hello world message',

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    // Always valid
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> = {},
    callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult> => {
    try {
      const response = 'Hello world!';

      if (callback) {
        await callback({
          text: response,
          actions: ['QUICK_ACTION'],
          source: message.content.source,
        });
      }

      return {
        text: response,
        success: true,
        data: {
          actions: ['QUICK_ACTION'],
          source: message.content.source,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Can you say hello?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'hello world!',
          actions: ['QUICK_ACTION'],
        },
      },
    ],
  ],
};

/**
 * Example Hello World Provider
 * This demonstrates the simplest possible provider implementation
 */
const quickProvider: Provider = {
  name: 'QUICK_PROVIDER',
  description: 'A simple example provider',

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<ProviderResult> => {
    return {
      text: 'I am a provider',
      values: {},
      data: {},
    };
  },
};

export class KaminoService extends Service {
  static override serviceType = 'Kamino';

  override capabilityDescription =
    'Provides access to Kamino Protocol — lending, borrowing, liquidity vaults, farms, and limit orders on Solana.';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    logger.info('Starting starter service');
    const service = new KaminoService(runtime);
    return service;
  }

  static override async stop(runtime: IAgentRuntime): Promise<void> {
    logger.info('Stopping starter service');
    const service = runtime.getService(KaminoService.serviceType);
    if (!service) {
      throw new Error('Starter service not found');
    }
    if ('stop' in service && typeof service.stop === 'function') {
      await service.stop();
    }
  }

  override async stop(): Promise<void> {
    logger.info('Starter service stopped');
  }
}

export const starterPlugin: Plugin = {
  name: 'plugin-kamino',
  description: 'plugin-kamino is the elizaos plugin of kamino. Lending, borrowing, earn etc. all features of kamino are available.',

  config: {
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
    SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY,
  },
  async init(config: Record<string, string>) {
    logger.info('Initializing plugin-kamino');
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      // Set all environment variables at once
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) process.env[key] = value;
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages =
          error.issues?.map((e) => e.message)?.join(', ') || 'Unknown validation error';
        throw new Error(`Invalid plugin configuration: ${errorMessages}`);
      }
      throw new Error(
        `Invalid plugin configuration: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
  
  routes: [
    {
      name: 'api-status',
      path: '/api/status',
      type: 'GET',
      handler: async (_req: RouteRequest, res: RouteResponse) => {
        res.json({
          status: 'ok',
          plugin: 'quick-starter',
          timestamp: new Date().toISOString(),
        });
      },
    },
  ],
  events: {
    [EventType.MESSAGE_RECEIVED]: [
      async (params: MessagePayload) => {
        logger.debug('MESSAGE_RECEIVED event received');
        logger.debug({ message: params.message }, 'Message:');
      },
    ],
    [EventType.VOICE_MESSAGE_RECEIVED]: [
      async (params: MessagePayload) => {
        logger.debug('VOICE_MESSAGE_RECEIVED event received');
        logger.debug({ message: params.message }, 'Message:');
      },
    ],
    [EventType.WORLD_CONNECTED]: [
      async (params: WorldPayload) => {
        logger.debug('WORLD_CONNECTED event received');
        logger.debug({ world: params.world }, 'World:');
      },
    ],
    [EventType.WORLD_JOINED]: [
      async (params: WorldPayload) => {
        logger.debug('WORLD_JOINED event received');
        logger.debug({ world: params.world }, 'World:');
      },
    ],
  },
  services: [KaminoService],
  actions: [quickAction],
  providers: [quickProvider],
  // dependencies: ['@elizaos/plugin-knowledge'], <--- plugin dependencies go here (if requires another plugin)
};

export default starterPlugin;
