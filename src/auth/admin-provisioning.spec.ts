import * as argon2 from 'argon2';

import type { PrismaClient } from '../generated/prisma/client';
import {
  formatAdminSummary,
  generateSecurePassword,
  getAdminCliHelp,
  isValidEmail,
  parseAdminCliArgs,
  provisionAdmin,
} from './admin-provisioning';

interface MockRole {
  id: string;
  name: string;
}

interface MockUser {
  id: string;
  email: string;
  name: string | null;
  emailVerifiedAt: Date | null;
}

interface CreateRoleArgs {
  data: {
    name: string;
    description: string;
    isDefault: boolean;
    permissions: { create: { permissionId: string }[] };
  };
}

interface CreateUserArgs {
  data: {
    email: string;
    name: string;
    passwordHash: string;
    roleId: string;
    emailVerifiedAt: Date;
  };
}

interface UpdateUserArgs {
  where: { id: string };
  data: {
    roleId: string;
    name: string;
    passwordHash: string;
    emailVerifiedAt: Date;
  };
}

interface MockPrismaClient {
  role: {
    findUnique: jest.Mock<
      Promise<MockRole | null>,
      [{ where: { name: string } }]
    >;
    create: jest.Mock<Promise<MockRole>, [CreateRoleArgs]>;
  };
  permission: {
    findMany: jest.Mock<
      Promise<{ id: string }[]>,
      [{ select: { id: boolean } }]
    >;
  };
  user: {
    findUnique: jest.Mock<
      Promise<MockUser | null>,
      [{ where: { email: string } }]
    >;
    create: jest.Mock<
      Promise<{ id: string; email: string; name: string | null }>,
      [CreateUserArgs]
    >;
    update: jest.Mock<
      Promise<{ id: string; email: string; name: string | null }>,
      [UpdateUserArgs]
    >;
  };
}

describe('Admin Provisioning CLI', () => {
  describe('isValidEmail', () => {
    it('validates correct email formats', () => {
      expect(isValidEmail('admin@usina.com.br')).toBe(true);
      expect(isValidEmail('user.name+tag@domain.co')).toBe(true);
      expect(isValidEmail('lojista_123@sub.store.io')).toBe(true);
    });

    it('rejects invalid email formats', () => {
      expect(isValidEmail('not-an-email')).toBe(false);
      expect(isValidEmail('@domain.com')).toBe(false);
      expect(isValidEmail('admin@')).toBe(false);
      expect(isValidEmail('admin @domain.com')).toBe(false);
      expect(isValidEmail('')).toBe(false);
    });
  });

  describe('generateSecurePassword', () => {
    it('generates a password of default length 16', () => {
      const password = generateSecurePassword();
      expect(password).toHaveLength(16);
      expect(typeof password).toBe('string');
    });

    it('generates a password of specified length', () => {
      const password = generateSecurePassword(24);
      expect(password).toHaveLength(24);
    });

    it('generates random distinct passwords on consecutive invocations', () => {
      const p1 = generateSecurePassword();
      const p2 = generateSecurePassword();
      expect(p1).not.toBe(p2);
    });
  });

  describe('parseAdminCliArgs', () => {
    it('parses flags with equal sign syntax', () => {
      const args = [
        '--email=admin@loja.com',
        '--name=Super Admin',
        '--password=SecretPass123!',
      ];
      const parsed = parseAdminCliArgs(args);
      expect(parsed).toEqual({
        email: 'admin@loja.com',
        name: 'Super Admin',
        password: 'SecretPass123!',
      });
    });

    it('parses flags with space-separated syntax and short flags', () => {
      const args = [
        '-e',
        'admin@loja.com',
        '-n',
        'Super Admin',
        '-p',
        'SecretPass123!',
      ];
      const parsed = parseAdminCliArgs(args);
      expect(parsed).toEqual({
        email: 'admin@loja.com',
        name: 'Super Admin',
        password: 'SecretPass123!',
      });
    });

    it('recognizes --help and -h', () => {
      expect(parseAdminCliArgs(['--help']).help).toBe(true);
      expect(parseAdminCliArgs(['-h']).help).toBe(true);
    });
  });

  describe('getAdminCliHelp', () => {
    it('returns a formatted help string containing usage instructions', () => {
      const help = getAdminCliHelp();
      expect(help).toContain('PROVISIONAMENTO DE ADMINISTRADOR');
      expect(help).toContain('--email');
      expect(help).toContain('--password');
    });
  });

  describe('provisionAdmin', () => {
    let mockPrisma: MockPrismaClient;

    beforeEach(() => {
      mockPrisma = {
        role: {
          findUnique: jest
            .fn<Promise<MockRole | null>, [{ where: { name: string } }]>()
            .mockResolvedValue({
              id: 'role-admin-id',
              name: 'admin',
            }),
          create: jest.fn<Promise<MockRole>, [CreateRoleArgs]>(),
        },
        permission: {
          findMany: jest
            .fn<Promise<{ id: string }[]>, [{ select: { id: boolean } }]>()
            .mockResolvedValue([{ id: 'perm-1' }]),
        },
        user: {
          findUnique: jest
            .fn<Promise<MockUser | null>, [{ where: { email: string } }]>()
            .mockResolvedValue(null),
          create: jest.fn<
            Promise<{ id: string; email: string; name: string | null }>,
            [CreateUserArgs]
          >(),
          update: jest.fn<
            Promise<{ id: string; email: string; name: string | null }>,
            [UpdateUserArgs]
          >(),
        },
      };
    });

    it('rejects if email is missing or empty', async () => {
      await expect(
        provisionAdmin({ email: '' }, mockPrisma as unknown as PrismaClient),
      ).rejects.toThrow('O e-mail do administrador é obrigatório');
    });

    it('rejects if email format is invalid', async () => {
      await expect(
        provisionAdmin(
          { email: 'invalid-email' },
          mockPrisma as unknown as PrismaClient,
        ),
      ).rejects.toThrow('não é um e-mail válido');
    });

    it('rejects if password is provided but shorter than 8 characters', async () => {
      await expect(
        provisionAdmin(
          { email: 'admin@loja.com', password: '123' },
          mockPrisma as unknown as PrismaClient,
        ),
      ).rejects.toThrow('no mínimo 8 caracteres');
    });

    it('creates a new admin user when user does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockImplementation(async ({ data }) => {
        expect(data.email).toBe('admin@loja.com');
        expect(data.name).toBe('Dono da Loja');
        expect(data.roleId).toBe('role-admin-id');
        expect(data.emailVerifiedAt).toBeInstanceOf(Date);
        expect(
          await argon2.verify(data.passwordHash, 'MinhaSenhaSegura123'),
        ).toBe(true);

        return {
          id: 'user-new-uuid',
          email: data.email,
          name: data.name,
        };
      });

      const result = await provisionAdmin(
        {
          email: '  Admin@Loja.Com  ',
          name: 'Dono da Loja',
          password: 'MinhaSenhaSegura123',
        },
        mockPrisma as unknown as PrismaClient,
      );

      expect(result.isNewUser).toBe(true);
      expect(result.passwordAutoGenerated).toBe(false);
      expect(result.password).toBe('MinhaSenhaSegura123');
      expect(result.user).toEqual({
        id: 'user-new-uuid',
        email: 'admin@loja.com',
        name: 'Dono da Loja',
        role: 'admin',
      });
    });

    it('auto-generates password if none provided for new admin', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'user-generated-uuid',
          email: data.email,
          name: data.name,
        }),
      );

      const result = await provisionAdmin(
        {
          email: 'novo-admin@loja.com',
        },
        mockPrisma as unknown as PrismaClient,
      );

      expect(result.isNewUser).toBe(true);
      expect(result.passwordAutoGenerated).toBe(true);
      expect(result.password).toHaveLength(16);
      expect(result.user.name).toBe('Administrador');
    });

    it('promotes an existing user and updates password/verification', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'existing-user-uuid',
        email: 'cliente@loja.com',
        name: 'Cliente Antigo',
        emailVerifiedAt: null,
      });

      mockPrisma.user.update.mockResolvedValue({
        id: 'existing-user-uuid',
        email: 'cliente@loja.com',
        name: 'Cliente Promovido',
      });

      const result = await provisionAdmin(
        {
          email: 'cliente@loja.com',
          name: 'Cliente Promovido',
          password: 'NovaSenhaDeAdmin123',
        },
        mockPrisma as unknown as PrismaClient,
      );

      expect(result.isNewUser).toBe(false);
      expect(result.passwordAutoGenerated).toBe(false);

      const updateCall = mockPrisma.user.update.mock.calls[0][0];
      expect(updateCall.where.id).toBe('existing-user-uuid');
      expect(updateCall.data.roleId).toBe('role-admin-id');
      expect(updateCall.data.name).toBe('Cliente Promovido');
      expect(updateCall.data.emailVerifiedAt).toBeInstanceOf(Date);
    });

    it('automatically creates admin role if not present in database', async () => {
      mockPrisma.role.findUnique.mockResolvedValue(null);
      mockPrisma.role.create.mockResolvedValue({
        id: 'auto-created-admin-role',
        name: 'admin',
      });
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({
        id: 'uuid-1',
        email: 'admin@loja.com',
        name: 'Administrador',
      });

      const result = await provisionAdmin(
        { email: 'admin@loja.com' },
        mockPrisma as unknown as PrismaClient,
      );

      const createRoleCall = mockPrisma.role.create.mock.calls[0][0];
      expect(createRoleCall.data.name).toBe('admin');
      expect(result.user.role).toBe('admin');
    });
  });

  describe('formatAdminSummary', () => {
    it('formats summary for new user with auto-generated password', () => {
      const summary = formatAdminSummary(
        {
          user: {
            id: 'uuid-123',
            email: 'admin@loja.com',
            name: 'Carlos Admin',
            role: 'admin',
          },
          password: 'RandomPassword123!',
          isNewUser: true,
          passwordAutoGenerated: true,
        },
        'https://minhaloja.com.br',
      );

      expect(summary).toContain('Novo Administrador Criado');
      expect(summary).toContain('Carlos Admin');
      expect(summary).toContain('admin@loja.com');
      expect(summary).toContain('RandomPassword123!');
      expect(summary).toContain('https://minhaloja.com.br/admin');
    });

    it('formats summary for promoted user with manual password', () => {
      const summary = formatAdminSummary({
        user: {
          id: 'uuid-456',
          email: 'promovido@loja.com',
          name: 'Operador Promovido',
          role: 'admin',
        },
        password: 'ManualPassword',
        isNewUser: false,
        passwordAutoGenerated: false,
      });

      expect(summary).toContain('Usuário Existente Elevado a Administrador');
      expect(summary).toContain('[Definida manualmente via parâmetro]');
    });
  });
});
