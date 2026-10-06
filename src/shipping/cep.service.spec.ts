import { BadRequestException, NotFoundException } from '@nestjs/common';

import { CepService } from './cep.service';

describe('CepService', () => {
  let service: CepService;

  beforeEach(() => {
    service = new CepService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects an invalid CEP format with BadRequestException', async () => {
    await expect(service.lookup('123')).rejects.toThrow(BadRequestException);
    await expect(service.lookup('abcdefgh')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('resolves address and formats postal code from BrasilAPI', async () => {
    jest.spyOn(global, 'fetch').mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            cep: '01310200',
            street: 'Avenida Paulista',
            neighborhood: 'Bela Vista',
            city: 'São Paulo',
            state: 'SP',
          }),
      } as Response),
    );

    const result = await service.lookup('01310-200');

    expect(result).toEqual({
      postalCode: '01310-200',
      street: 'Avenida Paulista',
      neighborhood: 'Bela Vista',
      city: 'São Paulo',
      state: 'SP',
    });
  });

  it('falls back to ViaCEP if BrasilAPI fails', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementationOnce(() => Promise.resolve({ ok: false } as Response))
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              cep: '01310-200',
              logradouro: 'Avenida Paulista',
              bairro: 'Bela Vista',
              localidade: 'São Paulo',
              uf: 'SP',
            }),
        } as Response),
      );

    const result = await service.lookup('01310200');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      postalCode: '01310-200',
      street: 'Avenida Paulista',
      neighborhood: 'Bela Vista',
      city: 'São Paulo',
      state: 'SP',
    });
  });

  it('throws NotFoundException if both providers fail or return not found', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve({
        ok: false,
      } as Response),
    );

    await expect(service.lookup('99999999')).rejects.toThrow(NotFoundException);
  });

  it('caches the resolved address for subsequent lookups', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            cep: '01310200',
            street: 'Avenida Paulista',
            neighborhood: 'Bela Vista',
            city: 'São Paulo',
            state: 'SP',
          }),
      } as Response),
    );

    const first = await service.lookup('01310-200');
    const second = await service.lookup('01310200');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });
});
