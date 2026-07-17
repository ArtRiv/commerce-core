import { Global, Module } from '@nestjs/common';

import { MAIL_SERVICE } from './mail.service';
import { ResendMailService } from './resend-mail.service';

@Global()
@Module({
  providers: [{ provide: MAIL_SERVICE, useClass: ResendMailService }],
  exports: [MAIL_SERVICE],
})
export class MailModule {}
