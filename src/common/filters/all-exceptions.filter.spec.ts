import {
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let responseMock: Partial<Response>;
  let requestMock: Partial<Request>;
  let hostMock: ArgumentsHost;
  let statusMock: jest.Mock;
  let jsonMock: jest.Mock;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    responseMock = {
      status: statusMock,
    };

    requestMock = {
      method: 'GET',
      url: '/orders/123',
    };

    hostMock = {
      switchToHttp: () => ({
        getResponse: () => responseMock as Response,
        getRequest: () => requestMock as Request,
        getNext: jest.fn(),
      }),
    } as unknown as ArgumentsHost;
  });

  it('deve formatar HttpException com seu status e mensagem de erro', () => {
    const exception = new HttpException(
      'Produto não encontrado',
      HttpStatus.NOT_FOUND,
    );

    filter.catch(exception, hostMock);

    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Produto não encontrado',
        timestamp: expect.any(String),
      }),
    );
  });

  it('deve capturar erro 500 inesperado, registrar log de erro e retornar mensagem genérica segura', () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const unhandled = new Error('Falha catastrófica de infra');

    filter.catch(unhandled, hostMock);

    expect(errorSpy).toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        message: 'Erro interno do servidor.',
        timestamp: expect.any(String),
      }),
    );

    errorSpy.mockRestore();
  });
});
