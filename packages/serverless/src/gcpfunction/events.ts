// '@google-cloud/functions-framework/build/src/functions' import is expected to be type-only so it's erased in the final .js file.
// When TypeScript compiler is upgraded, use `import type` syntax to explicitly assert that we don't want to load a module here.
import { EventFunction, EventFunctionWithCallback } from '@google-cloud/functions-framework/build/src/functions';
import { captureException, flush, getCurrentHub, startTransaction } from '@sentry/node';
import { logger } from '@sentry/utils';

import { configureScopeWithContext, getActiveDomain, WrapperOptions } from './general';

export type EventFunctionWrapperOptions = WrapperOptions;

/**
 * Wraps an event function handler adding it error capture and tracing capabilities.
 *
 * @param fn Event handler
 * @param options Options
 * @returns Event handler
 */
export function wrapEventFunction(
  fn: EventFunction | EventFunctionWithCallback,
  wrapOptions: Partial<EventFunctionWrapperOptions> = {},
): EventFunctionWithCallback {
  const options: EventFunctionWrapperOptions = {
    flushTimeout: 2000,
    ...wrapOptions,
  };
  return (data, context, callback) => {
    const transaction = startTransaction({
      name: context.eventType,
      op: 'gcp.function.event',
    });

    // getCurrentHub() is expected to use current active domain as a carrier
    // since functions-framework creates a domain for each incoming request.
    // So adding of event processors every time should not lead to memory bloat.
    getCurrentHub().configureScope(scope => {
      configureScopeWithContext(scope, context);
      // We put the transaction on the scope so users can attach children to it
      scope.setSpan(transaction);
    });

    const activeDomain = getActiveDomain();

    activeDomain.on('error', captureException);

    const newCallback = activeDomain.bind((...args: unknown[]) => {
      if (args[0] !== null && args[0] !== undefined) {
        captureException(args[0]);
      }
      transaction.finish();

      flush(options.flushTimeout)
        .then(() => {
          callback(...args);
        })
        .then(null, e => {
          logger.error(e);
        });
    });

    if (fn.length > 2) {
      return (fn as EventFunctionWithCallback)(data, context, newCallback);
    }

    Promise.resolve()
      .then(() => (fn as EventFunction)(data, context))
      .then(
        result => {
          newCallback(null, result);
        },
        err => {
          newCallback(err, undefined);
        },
      );
  };
}
