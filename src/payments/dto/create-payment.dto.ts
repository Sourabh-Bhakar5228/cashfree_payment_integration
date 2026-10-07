import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  MinLength,
} from 'class-validator';

export class CreatePaymentDto {
  @ApiProperty({
    description: 'Unique Student Registration Code in ERP/UMS',
    example: 'STU001',
  })
  @IsString()
  @IsNotEmpty()
  studentCode: string;

  @ApiProperty({
    description: 'Payment Amount in INR',
    example: 500,
  })
  @IsNumber()
  @IsPositive()
  amount: number;

  @ApiProperty({
    description: 'Purpose or description of the payment',
    example: 'Semester Fee',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  purpose: string;

  @ApiProperty({
    description: 'Student or Customer Full Name',
    example: 'Rahul Kumar',
  })
  @IsString()
  @IsNotEmpty()
  customerName: string;

  @ApiProperty({
    description: 'Customer Email for Receipt',
    example: 'rahul@example.com',
  })
  @IsEmail()
  customerEmail: string;

  @ApiProperty({
    description: 'Customer Contact Phone (10-digit number)',
    example: '9876543210',
  })
  @IsString()
  @IsNotEmpty()
  customerPhone: string;
}
