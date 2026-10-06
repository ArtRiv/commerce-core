import { ApiProperty } from '@nestjs/swagger';

export class CurrentUserResponse {
  @ApiProperty({
    format: 'uuid',
    example: '9b2f4a1e-0c33-4d7b-9f10-2a5c8e6d41bb',
  })
  id: string;

  @ApiProperty({ format: 'email', example: 'ada@example.com' })
  email: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Ada Lovelace',
  })
  name: string | null;

  @ApiProperty({ example: 'customer' })
  role: string;

  @ApiProperty({
    type: [String],
    example: ['products.read'],
  })
  permissions: string[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}
