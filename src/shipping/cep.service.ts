import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import type { CepResponse } from './responses/cep.response';
import { normalizePostalCode } from './shipping-table';

interface CacheEntry {
  data: CepResponse;
  expiresAt: number;
}

/**
 * Service for Brazilian postal code (CEP) resolution.
 *
 * Queries BrasilAPI with automatic fallback to ViaCEP, backed by
 * an in-memory TTL cache to minimize external network trips.
 */
@Injectable()
export class CepService {
  private readonly logger = new Logger(CepService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs = 24 * 60 * 60 * 1000; // 24 hours

  async lookup(rawPostalCode: string): Promise<CepResponse> {
    const normalized = normalizePostalCode(rawPostalCode);

    if (!normalized) {
      throw new BadRequestException('CEP inválido. Deve conter 8 dígitos.');
    }

    const cached = this.cache.get(normalized);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    let address = await this.fetchBrasilApi(normalized);

    if (!address) {
      address = await this.fetchViaCep(normalized);
    }

    if (!address) {
      throw new NotFoundException('CEP não encontrado.');
    }

    this.cache.set(normalized, {
      data: address,
      expiresAt: Date.now() + this.ttlMs,
    });

    return address;
  }

  private async fetchBrasilApi(cep: string): Promise<CepResponse | null> {
    try {
      const response = await fetch(
        `https://brasilapi.com.br/api/cep/v2/${cep}`,
        {
          signal: AbortSignal.timeout(3500),
        },
      );

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as {
        cep?: string;
        street?: string;
        neighborhood?: string;
        city?: string;
        state?: string;
      };

      if (!data.city || !data.state) {
        return null;
      }

      return {
        postalCode: `${cep.slice(0, 5)}-${cep.slice(5)}`,
        street: data.street ?? '',
        neighborhood: data.neighborhood ?? '',
        city: data.city,
        state: data.state,
      };
    } catch (error: unknown) {
      this.logger.warn(`BrasilAPI lookup failed for ${cep}: ${String(error)}`);
      return null;
    }
  }

  private async fetchViaCep(cep: string): Promise<CepResponse | null> {
    try {
      const response = await fetch(`https://viacep.com.br/ws/${cep}/json/`, {
        signal: AbortSignal.timeout(3500),
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as {
        erro?: boolean | string;
        cep?: string;
        logradouro?: string;
        bairro?: string;
        localidade?: string;
        uf?: string;
      };

      if (data.erro || !data.localidade || !data.uf) {
        return null;
      }

      return {
        postalCode: `${cep.slice(0, 5)}-${cep.slice(5)}`,
        street: data.logradouro ?? '',
        neighborhood: data.bairro ?? '',
        city: data.localidade,
        state: data.uf,
      };
    } catch (error) {
      this.logger.warn(`ViaCEP lookup failed for ${cep}: ${String(error)}`);
      return null;
    }
  }
}
