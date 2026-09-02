import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * The role by NAME, not by id.
 *
 * Names are unique, they are what a panel shows, and a cuid is nobody's
 * choice. The name is not an enum here because roles are rows in the database
 * — the three seeded ones are what a fresh install has, not what the type
 * system guarantees — so an unknown name is checked against the table and
 * refused with 400 naming the ones that exist.
 */
export class ChangeRoleDto {
  @ApiProperty({
    description:
      'Name of the role this account moves to. The seeded roles are `customer` (no back-office access), `operator` (reads the catalogue, works the orders) and `admin` (everything, including `staff.manage`).\n\nAn unknown name is a **400** that lists the valid ones, rather than a 404: a role is a value from a small closed vocabulary here, not a resource whose existence could be worth hiding.',
    example: 'operator',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  role: string;
}
