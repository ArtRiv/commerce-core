# Diretrizes Mandatórias de Fluxo de Trabalho (Commerce-Core & AVESSO Store)

## 1. Gestão de Branches, Commits e Pull Requests por Sessão
- **Branch por Sessão:** No início de cada sessão de trabalho, crie ou alterne para uma feature branch dedicada (ex: `feat/session-11-shopee`). Nunca trabalhe direto na `main` ou deixe alterações desordenadas.
- **Commits Estruturados:** Ao longo e ao término do trabalho, realize commits atômicos e descritivos seguindo Conventional Commits (`feat(...)`, `fix(...)`, `test(...)`, `docs(...)`).
- **Pull Request Obrigatório:** Toda sessão deve concluir com as alterações commitadas na branch correspondente, com build e testes 100% verdes, e fornecer instruções claras para o usuário revisar e aprovar o Pull Request (PR) correspondente.
- **Upstream-First:** Mudanças de regras de negócio, schema de banco e contratos nascem aqui no `commerce-core`, geram OpenAPI (`pnpm run openapi:generate`), e sincronizam tipos no front (`pnpm api:types`).
- **Qualidade Contínua:** Nunca finalizar uma sessão sem garantir 100% de sucesso em `pnpm test` (Jest) e `pnpm build` (`nest build`).
