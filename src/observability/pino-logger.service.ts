import { Injectable, LoggerService, LogLevel, Optional } from '@nestjs/common';
import pino, {
  DestinationStream,
  Logger as PinoInstance,
  LoggerOptions,
} from 'pino';
import pretty from 'pino-pretty';

import { RequestContextService } from './request-context.service';

export interface PinoLoggerOptions {
  level?: string;
  context?: string;
  stream?: DestinationStream;
  pretty?: boolean;
}

const DEFAULT_REDACT_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'secret',
  '*.secret',
  'clientSecret',
  '*.clientSecret',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'headers.authorization',
  'headers["authorization"]',
  'headers.cookie',
  'headers["cookie"]',
  'creditCard',
  '*.creditCard',
  'cardNumber',
  '*.cardNumber',
  'cvv',
  '*.cvv',
  'encryptedBuyerPii',
  '*.encryptedBuyerPii',
  'buyerPii',
  '*.buyerPii',
  'cpf',
  '*.cpf',
];

/**
 * Serviço de Log Estruturado de Alta Performance baseado em Pino.
 *
 * Integra com AsyncLocalStorage para injetar automaticamente:
 *   - tenant_id
 *   - order_id
 *   - correlation_id
 *   - user_id
 *
 * Redige automaticamente dados sensíveis (senhas, segredos, tokens, PII e cartões).
 */
@Injectable()
export class PinoLoggerService implements LoggerService {
  private pinoInstance: PinoInstance;
  private defaultContext?: string;

  constructor(@Optional() options?: PinoLoggerOptions) {
    this.defaultContext = options?.context;
    this.pinoInstance = this.createPinoInstance(options);
  }

  private createPinoInstance(options?: PinoLoggerOptions): PinoInstance {
    const nodeEnv = process.env.NODE_ENV ?? 'development';
    const isTest = nodeEnv === 'test';
    const isProd = nodeEnv === 'production';

    const defaultLevel = isTest
      ? process.env.LOG_LEVEL || 'silent'
      : process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');

    const level = options?.level ?? defaultLevel;

    const pinoOptions: LoggerOptions = {
      level,
      redact: {
        paths: DEFAULT_REDACT_PATHS,
        censor: '[REDACTED]',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    };

    if (options?.stream) {
      return pino(pinoOptions, options.stream);
    }

    const wantPretty =
      options?.pretty ??
      (process.env.LOG_PRETTY === 'true' || (!isProd && !isTest));

    if (wantPretty) {
      const prettyStream = pretty({
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
      });
      return pino(pinoOptions, prettyStream);
    }

    return pino(pinoOptions);
  }

  /**
   * Define o contexto padrão para instâncias deste logger.
   */
  setContext(context: string): void {
    this.defaultContext = context;
  }

  /**
   * Cria um sub-logger ou logger escopado com contexto fixo.
   */
  forContext(context: string): PinoLoggerService {
    const scoped = new PinoLoggerService({
      context,
      level: this.pinoInstance.level,
    });
    scoped.pinoInstance = this.pinoInstance;
    return scoped;
  }

  /**
   * Retorna a instância interna do Pino.
   */
  getPinoInstance(): PinoInstance {
    return this.pinoInstance;
  }

  log(message: any, ...optionalParams: any[]): void {
    this.emitLog('info', message, optionalParams);
  }

  error(message: any, ...optionalParams: any[]): void {
    this.emitLog('error', message, optionalParams);
  }

  warn(message: any, ...optionalParams: any[]): void {
    this.emitLog('warn', message, optionalParams);
  }

  debug(message: any, ...optionalParams: any[]): void {
    this.emitLog('debug', message, optionalParams);
  }

  verbose(message: any, ...optionalParams: any[]): void {
    this.emitLog('trace', message, optionalParams);
  }

  fatal(message: any, ...optionalParams: any[]): void {
    this.emitLog('fatal', message, optionalParams);
  }

  setLogLevels?(levels: LogLevel[]): void {
    if (levels.includes('verbose')) {
      this.pinoInstance.level = 'trace';
    } else if (levels.includes('debug')) {
      this.pinoInstance.level = 'debug';
    } else if (levels.includes('log')) {
      this.pinoInstance.level = 'info';
    } else if (levels.includes('warn')) {
      this.pinoInstance.level = 'warn';
    } else if (levels.includes('error') || levels.includes('fatal')) {
      this.pinoInstance.level = 'error';
    }
  }

  private emitLog(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: any,
    optionalParams: any[],
  ): void {
    // 1. Injeta metadados provenientes do AsyncLocalStorage
    const store = RequestContextService.getStore();
    const meta: Record<string, unknown> = {};

    if (store?.tenantId) {
      meta.tenant_id = store.tenantId;
    }
    if (store?.orderId) {
      meta.order_id = store.orderId;
    }
    if (store?.correlationId) {
      meta.correlation_id = store.correlationId;
    }
    if (store?.userId) {
      meta.user_id = store.userId;
    }

    // 2. Extrai contexto, stack trace e mensagem de optionalParams do NestJS
    let context = this.defaultContext;
    let stack: string | undefined;
    let customMsg: string | undefined;
    const extraMeta: Record<string, unknown> = {};

    const isMessagePlainObject =
      typeof message === 'object' &&
      message !== null &&
      !(message instanceof Error) &&
      !('msg' in (message as Record<string, unknown>)) &&
      !('message' in (message as Record<string, unknown>));

    if (optionalParams.length > 0) {
      for (const param of optionalParams) {
        if (typeof param === 'string') {
          // Se parece com stack trace
          if (param.includes('\n') || param.startsWith('Error:')) {
            stack = param;
          } else if (isMessagePlainObject && !customMsg) {
            // Estilo Pino: logger.log({ meta }, 'Mensagem descritiva')
            customMsg = param;
          } else {
            context = param;
          }
        } else if (param instanceof Error) {
          stack = param.stack;
          extraMeta.err = {
            message: param.message,
            name: param.name,
            stack: param.stack,
          };
        } else if (typeof param === 'object' && param !== null) {
          Object.assign(extraMeta, param);
        }
      }
    }

    if (context) {
      meta.context = context;
    }
    Object.assign(meta, extraMeta);

    // 3. Processa mensagem e erros
    let logMsg = customMsg ?? '';
    if (message instanceof Error) {
      logMsg = message.message;
      meta.err = {
        message: message.message,
        name: message.name,
        stack: message.stack,
      };
    } else if (typeof message === 'object' && message !== null) {
      const record = message as Record<string, unknown>;
      if (typeof record.message === 'string') {
        logMsg = record.message;
      } else if (typeof record.msg === 'string') {
        logMsg = record.msg;
      }
      Object.assign(meta, record);
    } else {
      logMsg = String(message ?? '');
    }

    if (stack && !meta.err) {
      meta.err = { stack };
    }

    // 4. Dispara log estruturado via Pino
    this.pinoInstance[level](meta, logMsg);
  }
}
