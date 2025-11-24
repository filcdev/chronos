import { getLogger } from '@logtape/logtape';
import { Hono } from 'hono';
import { getConnInfo } from 'hono/bun';
import { cors } from 'hono/cors';
import { showRoutes } from 'hono/dev';
import { HTTPException } from 'hono/http-exception';
import { StatusCodes } from 'http-status-codes';
import { prepareDb } from '~/database';
import { frontend } from '~/frontend/server';
import { handleMqttShutdown, initializeMqttClient } from '~/mqtt/client';
import { developmentRouter } from '~/routes/_dev/_router';
import { cohortRouter } from '~/routes/cohort/_router';
import { doorlockRouter } from '~/routes/doorlock/_router';
import { featureFlagRouter } from '~/routes/feature-flags/_router';
import { pingRouter } from '~/routes/ping/_router';
import { timetableRouter } from '~/routes/timetable/_router';
import { authRouter } from '~/utils/authentication';
import { initializeRBAC } from '~/utils/authorization';
import { startDeviceMonitor, stopDeviceMonitor } from '~/utils/device-monitor';
import { env } from '~/utils/environment';
import { handleFeatureFlag } from '~/utils/feature-flag';
import type { Context, ErrorResponse } from '~/utils/globals';
import { configureLogger } from '~/utils/logger';
import { authenticationMiddleware } from '~/utils/middleware';
import { securityMiddleware } from '~/utils/security';
import {
  initializeTimetableCache,
  stopTimetableCache,
} from '~/utils/timetable-cache';

await configureLogger('chronos');
const logger = getLogger(['chronos', 'server']);

if (env.mode === 'development') {
  logger.warn('Running in development mode, do not use in production!');
}

const api = new Hono<Context>();

await prepareDb();
await initializeRBAC();

api.use(
  '*',
  cors({
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    origin: env.mode === 'development' ? '*' : env.baseUrl,
  })
);

api.use('*', authenticationMiddleware);

if (env.mode === 'production') {
  api.use('*', securityMiddleware);
}

api.onError((err, c) => {
  if (err instanceof HTTPException) {
    const errResponse =
      err.res ??
      c.json<ErrorResponse>(
        {
          cause: env.mode === 'production' ? undefined : err.cause,
          error: err.message,
          success: false,
        },
        err.status
      );
    return errResponse;
  }

  return c.json<ErrorResponse>(
    {
      cause: err instanceof Error ? err.cause : undefined,
      error:
        env.mode === 'production'
          ? 'Internal Server Error'
          : (err.stack ?? err.message),
      success: false,
    },
    StatusCodes.INTERNAL_SERVER_ERROR
  );
});

if (env.mode === 'development') {
  api.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    logger.trace(`${c.req.method} ${c.req.url} - ${ms}ms`, {
      duration: ms,
      method: c.req.method,
      url: c.req.url,
      user: c.get('user')
        ? { email: c.get('user')?.email, id: c.get('user')?.id }
        : null,
    });
  });
} else {
  api.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    const connInfo = getConnInfo(c);
    const remoteAddr = env.realIpHeader
      ? c.req.header(env.realIpHeader)
      : connInfo?.remote.address;
    logger.info('Received request', {
      duration: ms,
      ip: remoteAddr ?? 'unknown',
      method: c.req.method,
      ua: c.req.header('user-agent') ?? 'unknown',
      url: c.req.url,
      user: c.get('user')
        ? { email: c.get('user')?.email, id: c.get('user')?.id }
        : null,
    });
  });
}

// routes
if (env.mode === 'development') {
  api.route('/_dev', developmentRouter);
}
api.route('/auth', authRouter);
api.route('/ping', pingRouter);
api.route('/feature-flags', featureFlagRouter);
api.route('/timetable', timetableRouter);
api.route('/cohort', cohortRouter);

// Register feature flag for doorlock API with initial check
await handleFeatureFlag('doorlock:api', 'Enable doorlock API', false);
api.route('/doorlock', doorlockRouter);

const app = new Hono();
app.route('/api', api);
app.route('/', frontend);

app.onError((err, c) => {
  logger.error('Unhandled error occurred:', {
    message: err.message,
    stack: err.stack,
  });
  return c.redirect('/error');
});

const handleStartup = async () => {
  await prepareDb();
  await initializeRBAC();
  // Preload timetables and substitutions for all cohorts to avoid first-request latency
  await initializeTimetableCache({ preload: true });
  await initializeMqttClient();
  await startDeviceMonitor();

  if (env.mode === 'production') {
    Bun.serve({
      fetch: app.fetch,
      port: env.port,
    });
  }

  logger.info('chronos started on http://localhost:3000');
  if (env.logLevel === 'trace') {
    logger.info('Log level set to TRACE, verbose route listing enabled');
    showRoutes(app, { verbose: true });
  }
};

const handleShutdown = () => {
  logger.info('Shutting down chronos...');
  handleMqttShutdown();
  stopTimetableCache();
  stopDeviceMonitor();
  logger.info('Shutdown complete, exiting.');
  process.exit(0);
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

await handleStartup();

export type ApiType = typeof api;
export type AppType = typeof app;

export default env.mode === 'development' ? app : null;
