// @flow

import {
  map,
} from 'inline-loops.macro';
import {
  getStackTrace,
} from 'get-stack-trace';
import {
  serializeError,
} from 'serialize-error';
import {
  createQueryId,
  normaliseQueryValues,
} from '../utilities';
import {
  BackendTerminatedError,
  CheckIntegrityConstraintViolationError,
  ForeignKeyIntegrityConstraintViolationError,
  InvalidInputError,
  NotNullIntegrityConstraintViolationError,
  StatementCancelledError,
  StatementTimeoutError,
  UniqueIntegrityConstraintViolationError,
} from '../errors';
import type {
  ClientConfigurationType,
  InternalDatabaseConnectionType,
  LoggerType,
  PrimitiveValueExpressionType,
  QueryContextType,
  QueryIdType,
  QueryResultRowType,
  QueryType,
} from '../types';

type ExecutionRoutineType = (
  connection: InternalDatabaseConnectionType,
  sql: string,
  values: $ReadOnlyArray<PrimitiveValueExpressionType>,
  queryContext: QueryContextType,
  query: QueryType
) => Promise<*>;

// eslint-disable-next-line complexity
export default async (
  connectionLogger: LoggerType,
  connection: InternalDatabaseConnectionType,
  clientConfiguration: ClientConfigurationType,
  rawSql: string,
  values: $ReadOnlyArray<PrimitiveValueExpressionType>,
  inheritedQueryId?: QueryIdType,
  executionRoutine: ExecutionRoutineType,
) => {
  if (connection.connection.slonik.terminated) {
    throw new BackendTerminatedError(connection.connection.slonik.terminated);
  }

  if (rawSql.trim() === '') {
    throw new InvalidInputError('Unexpected SQL input. Query cannot be empty.');
  }

  if (rawSql.trim() === '$1') {
    throw new InvalidInputError('Unexpected SQL input. Query cannot be empty. Found only value binding.');
  }

  const queryInputTime = process.hrtime.bigint();

  let stackTrace = null;

  if (clientConfiguration.captureStackTrace) {
    const callSites = await getStackTrace();

    stackTrace = map(callSites, (callSite) => {
      return {
        columnNumber: callSite.columnNumber,
        fileName: callSite.fileName,
        lineNumber: callSite.lineNumber,
      };
    });
  }

  const queryId = inheritedQueryId || createQueryId();

  const log = connectionLogger.child({
    queryId,
  });

  const originalQuery = {
    sql: rawSql,
    values,
  };

  let actualQuery = {
    ...originalQuery,
  };

  const executionContext: QueryContextType = {
    connectionId: connection.connection.slonik.connectionId,
    log,
    originalQuery,
    poolId: connection.connection.slonik.poolId,
    queryId,
    queryInputTime,
    sandbox: {},
    stackTrace,
    transactionId: connection.connection.slonik.transactionId,
  };

  for (const interceptor of clientConfiguration.interceptors) {
    if (interceptor.beforeTransformQuery) {
      interceptor.beforeTransformQuery(executionContext, actualQuery);
    }
  }

  for (const interceptor of clientConfiguration.interceptors) {
    if (interceptor.transformQuery) {
      actualQuery = interceptor.transformQuery(executionContext, actualQuery);
    }
  }

  let result;

  for (const interceptor of clientConfiguration.interceptors) {
    if (interceptor.beforeQueryExecution) {
      result = await interceptor.beforeQueryExecution(executionContext, actualQuery);

      if (result) {
        log.info('beforeQueryExecution interceptor produced a result; short-circuiting query execution using beforeQueryExecution result');

        return result;
      }
    }
  }

  const notices = [];

  const noticeListener = (notice) => {
    notices.push(notice);
  };

  connection.on('notice', noticeListener);

  try {
    try {
      result = await executionRoutine(
        connection,
        actualQuery.sql,
        normaliseQueryValues(actualQuery.values, connection.native),
        executionContext,
        actualQuery,
      );
    } catch (error) {
      log.error({
        error: serializeError(error),
      }, 'execution routine produced an error');

      // 'Connection terminated' refers to node-postgres error.
      // @see https://github.com/brianc/node-postgres/blob/eb076db5d47a29c19d3212feac26cd7b6d257a95/lib/client.js#L199
      if (error.code === '57P01' || error.message === 'Connection terminated') {
        connection.connection.slonik.terminated = error;

        throw new BackendTerminatedError(error);
      }

      if (error.code === '57014' && error.message.includes('canceling statement due to statement timeout')) {
        throw new StatementTimeoutError(error);
      }

      if (error.code === '57014') {
        throw new StatementCancelledError(error);
      }

      if (error.code === '23502') {
        throw new NotNullIntegrityConstraintViolationError(error, error.constraint);
      }

      if (error.code === '23503') {
        throw new ForeignKeyIntegrityConstraintViolationError(error, error.constraint);
      }

      if (error.code === '23505') {
        throw new UniqueIntegrityConstraintViolationError(error, error.constraint);
      }

      if (error.code === '23514') {
        throw new CheckIntegrityConstraintViolationError(error, error.constraint);
      }

      throw error;
    } finally {
      connection.off('notice', noticeListener);
    }
  } catch (error) {
    for (const interceptor of clientConfiguration.interceptors) {
      if (interceptor.queryExecutionError) {
        await interceptor.queryExecutionError(executionContext, actualQuery, error);
      }
    }

    throw error;
  }

  // $FlowFixMe
  result.notices = notices;

  for (const interceptor of clientConfiguration.interceptors) {
    if (interceptor.afterQueryExecution) {
      await interceptor.afterQueryExecution(executionContext, actualQuery, result);
    }
  }

  // Stream does not have `rows` in the result object and all rows are already transformed.
  if (result.rows) {
    for (const interceptor of clientConfiguration.interceptors) {
      if (interceptor.transformRow) {
        const transformRow = interceptor.transformRow;
        const fields = result.fields;

        // eslint-disable-next-line no-loop-func
        const rows: $ReadOnlyArray<QueryResultRowType> = map(result.rows, (row) => {
          return transformRow(executionContext, actualQuery, row, fields);
        });

        result = {
          ...result,
          rows,
        };
      }
    }
  }

  for (const interceptor of clientConfiguration.interceptors) {
    if (interceptor.beforeQueryResult) {
      await interceptor.beforeQueryResult(executionContext, actualQuery, result);
    }
  }

  return result;
};
