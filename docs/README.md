# Docs

Índice da documentação viva do projeto. Isto complementa (não substitui)
[`claude/context.md`](../claude/context.md), que tem o contexto geral e as
convenções combinadas para trabalhar com o Claude Code neste repo.

- [`workflow.md`](workflow.md) — como uma feature nasce aqui: spec →
  TDD → e2e → docs de arquitetura atualizados.
- [`security.md`](security.md) — padrões de segurança adotados no
  projeto (senha, tokens, rate limiting), com base no OWASP Cheat
  Sheet Series. Vale pro projeto inteiro, não só pro auth.
- [`specs/`](specs/) — specs por módulo/feature, escritas _antes_ da
  implementação. `TEMPLATE.md` é o ponto de partida.
- [`architecture/`](architecture/) — diagramas Mermaid da arquitetura
  (visão de contexto, mapa de módulos). Começam como desenho-alvo antes
  de qualquer módulo existir; atualize o diagrama sempre que a
  implementação divergir do que está desenhado, pra não virar
  documentação morta.
- [`known-issues.md`](known-issues.md) — bugs e lacunas encontrados
  depois que um módulo já foi entregue, aceitos por ora mas não
  esquecidos. Não é backlog de feature (isso mora nas "decisões
  adiadas" de cada spec) — é especificamente coisa que está, de algum
  jeito pequeno, errada.
