import { IsString, Length, Matches } from 'class-validator';

export class RegisterDto {
  @IsString()
  @Length(4, 64)
  inviteCode!: string;

  @IsString()
  @Length(2, 80)
  displayName!: string;

  @IsString()
  @Length(2, 40)
  studentNumber!: string;

  @IsString()
  @Length(10, 128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, { message: '密码必须同时包含字母和数字' })
  password!: string;
}

export class LoginDto {
  @IsString()
  @Length(2, 40)
  studentNumber!: string;

  @IsString()
  @Length(1, 128)
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  @Length(1, 128)
  currentPassword!: string;

  @IsString()
  @Length(10, 128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, { message: '密码必须同时包含字母和数字' })
  newPassword!: string;
}
