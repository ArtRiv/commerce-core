import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Payload for purchasing a shipping label for a PAID order.
 * The operator selects an available carrier service (e.g. from Melhor Envio).
 */
export class PurchaseLabelDto {
  @ApiProperty({
    description:
      'The carrier service code to purchase the label for. Formatted as "melhorenvio.{service_id}".',
    example: 'melhorenvio.1',
    maxLength: 64,
  })
  @IsNotEmpty({ message: 'O código do serviço de frete é obrigatório.' })
  @IsString()
  @MaxLength(64)
  @Matches(/^melhorenvio\.\d+$/, {
    message: 'O código do serviço deve estar no formato "melhorenvio.{id}".',
  })
  serviceCode: string;
}
