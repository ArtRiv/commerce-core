import { Module } from '@nestjs/common';

import { MAIL_SERVICE } from './mail.service';
import { ResendMailService } from './resend-mail.service';

/**
 * Infrastructure behind a token, same shape as payments and shipping: the
 * Resend adapter is hidden, and swapping providers is a change here and
 * nowhere else.
 *
 * Deliberately NOT @Global, for the reason those two modules already give in
 * docs/architecture/modules.md — importing the module is what keeps the
 * dependency visible in the graph. It was global while `auth` was the only
 * consumer; once `orders` needed it too, the module map would have been
 * drawing two arrows that no code enforced.
 */
@Module({
  providers: [{ provide: MAIL_SERVICE, useClass: ResendMailService }],
  exports: [MAIL_SERVICE],
})
export class MailModule {}
