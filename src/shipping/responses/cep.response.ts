import { ApiProperty } from '@nestjs/swagger';

export class CepResponse {
  @ApiProperty({ example: '01310-200' })
  postalCode: string;

  @ApiProperty({ example: 'Avenida Paulista' })
  street: string;

  @ApiProperty({ example: 'Bela Vista' })
  neighborhood: string;

  @ApiProperty({ example: 'São Paulo' })
  city: string;

  @ApiProperty({ example: 'SP' })
  state: string;
}
