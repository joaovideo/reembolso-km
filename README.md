# Reembolso KM

Registro de deslocamentos de carro e cálculo de reembolso de quilometragem para uma equipe pequena. Os colaboradores iniciais vêm de `COLABORADORES` no `.env` e podem ser gerenciados em Configurações. Informa origem e destino, o app calcula a rota e a distância pelo Google Maps, estima quanto custaria de UberX e de táxi em São Paulo, e gera relatório por período e por colaborador com o total a reembolsar.

## Stack
- Node.js ≥ 22.13 (usa o SQLite embutido, `node:sqlite`; sem compilar nada), Express
- Frontend HTML/JS puro, mapa com Leaflet + OpenStreetMap (sem chave)
- Google Maps Platform, **só no servidor**: Routes API (rota/distância) e Places API (New) (autocomplete de endereço)
- Banco: `data/reembolso.sqlite` (fora do git)

## Rodar
```bash
npm install
cp .env.example .env   # e preencha GOOGLE_MAPS_API_KEY
npm start              # http://localhost:3080
```
`npm run dev` reinicia sozinho ao editar. `npm test` roda os testes das tabelas de tarifa.

## Chave do Google Maps (passo a passo)
1. Acesse https://console.cloud.google.com/ e, no topo, crie um projeto (ex.: `reembolso-km`) ou escolha um existente.
2. **Faturamento**: menu ☰ → *Faturamento* → vincule uma conta de faturamento ao projeto. Sem isso as APIs não respondem. Cada API tem cota grátis mensal (Routes: 10.000 rotas/mês; Autocomplete: 10.000 requisições/mês). O uso da equipe fica muito abaixo disso.
3. **Ativar APIs**: menu ☰ → *APIs e serviços* → *Biblioteca*. Procure e ative:
   - **Routes API**
   - **Places API (New)** (atenção: a "(New)", não a "Places API" antiga)
4. **Criar a chave**: *APIs e serviços* → *Credenciais* → *+ Criar credenciais* → *Chave de API*.
5. **Restringir a chave** (recomendado): clique na chave → em *Restrições de API* marque *Restringir chave* e selecione só **Routes API** e **Places API (New)**. Em *Restrições de aplicativo* deixe *Nenhuma* (a chave só é usada pelo servidor; se quiser, use *Endereços IP* com o IP fixo do servidor). Salvar.
6. **Entregar a chave ao app**: na pasta do projeto, crie o arquivo `.env` (cópia do `.env.example`) e cole a chave na linha `GOOGLE_MAPS_API_KEY=`. Não mande a chave por chat nem a commite; o `.env` está no `.gitignore`.
7. Reinicie (`npm start`). O aviso laranja no topo da página desaparece quando a chave está carregada; a tela de status é `GET /api/status`.

Para acompanhar o consumo: *APIs e serviços* → *Painel*. Para não ter surpresa, defina um alerta de orçamento em *Faturamento* → *Orçamentos e alertas* (ex.: R$ 50).

## Regras de cálculo
Tudo editável em **Configurações**; os defaults são a referência de out/2026 para São Paulo capital.

**Reembolso** — três formas:
- **Uber informado** (tem prioridade): no cadastro da viagem há o campo "Valor do Uber agora". Quem está registrando abre o app do Uber, vê quanto custaria a corrida de ida naquele momento e digita. O reembolso passa a ser exatamente esse valor; em ida e volta, o dobro. Fica gravado na coluna `uber_manual` e aparece como "Uber informado" na lista, no relatório e no CSV.
- `km_fixo` (padrão quando o campo fica vazio): km × **R$ 2,90/km**. O valor é a média do UberX em SP fora de pico no centro expandido (área do rodízio): R$ 1,65/km + R$ 0,35/min a ~25 km/h (2,4 min/km) + tarifa base (R$ 2,50) e taxa de reserva (R$ 2,00) amortizadas numa corrida de ~10 km.
- `uber_fora_pico`: a estimativa UberX da própria rota, com multiplicador 1,0 (sem preço dinâmico).

**UberX (estimativa)** — `(base + km×por_km + min×por_min) × multiplicador + taxa de reserva`, mínimo a tarifa mínima. O multiplicador vem da faixa de horário (pico manhã 7–10h ×1,30; pico tarde 17–20h ×1,40; noite ×1,10; sexta/sábado à noite ×1,25; madrugada ×1,20; fora disso ×1,00). A Uber não tem API pública de preço: isso é uma aproximação, e o app sempre mostra também o valor "fora de pico" para comparação.

**Táxi comum (tabela oficial, Portaria SMT, vigente desde 11/08/2025)** — bandeirada R$ 6,55 + km × R$ 4,80 (bandeira 1) ou R$ 6,24 (bandeira 2, +30%) + tempo parado × R$ 55,50/h. Bandeira 2: 20h–6h de segunda a sábado, e domingos e feriados o dia todo (feriados nacionais + 9/7 estadual + 25/1 e 20/11 municipais, calculados pelo app). Tempo parado = o que a viagem demora além do que levaria a 30 km/h.

A distância e o tempo vêm do Google (Routes API). Para "ida e volta" o app calcula as duas direções e soma. Os valores são gravados na hora do registro: mudar a tabela depois não altera viagens antigas.

## API
| Método | Rota | O que faz |
|---|---|---|
| GET | `/api/status` | chave configurada?, versão, caminho do banco |
| GET/POST/PATCH | `/api/colaboradores` | lista, adiciona, ativa/desativa |
| GET/PUT | `/api/config` | tabelas de tarifa e modo de reembolso |
| GET | `/api/places?q=` | autocomplete de endereço |
| POST | `/api/calcular` | rota + estimativas, sem gravar |
| GET/POST/DELETE | `/api/viagens` | filtros `de`, `ate`, `colaborador_id` |
| GET | `/api/relatorio`, `/api/relatorio.csv` | totais por colaborador + detalhamento |

Logs vão para o stdout com horário local (GMT-3): cada cálculo, viagem salva/excluída, alteração de config e erro do Google.

## Senha de acesso
Defina `APP_USER` e `APP_PASS` no `.env` e o app passa a exigir login (Basic Auth, o navegador pede uma vez e lembra). Sem as duas variáveis o app fica aberto, o que só serve para uso local. Atrás de um proxy reverso, defina `TRUSTED_PROXIES` com o IP dele para o log registrar o IP real do cliente.

## Deploy (servidor próprio)
- Linux com systemd. O script instala o Node 22 (NodeSource) se faltar, cria `/opt/reembolso-km`, copia o `.env` local (com a chave do Google), gera usuário e senha de acesso e sobe o serviço `reembolso-km` na porta 3080.
- Instalar: `REEMBOLSO_HOST=usuario@servidor scripts/install-server.sh` (opcional: `REEMBOLSO_USER` para o login, `REEMBOLSO_PROXY` com o IP do proxy reverso).
- Atualizar: `scripts/deploy.sh usuario@servidor` (guarda a versão anterior inteira, código e banco, em `/opt/reembolso-km.prev`). Voltar: `scripts/rollback.sh`. Desinstalar: `scripts/uninstall-server.sh`.
- Trocar a senha de acesso: `scripts/set-password.sh usuario@servidor` (pede a senha no terminal).
- Banco em `/opt/reembolso-km/data/reembolso.sqlite` (fora do git).
- Para expor na internet, coloque um proxy reverso com TLS na frente (HAProxy, nginx, Caddy) apontando para a porta 3080 e defina `TRUSTED_PROXIES` com o IP dele.
