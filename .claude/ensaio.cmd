@echo off
rem ===================================================================
rem  Instancia de ENSAIO do wiztools.
rem
rem  Uma linha, porque e uma linha: o modo --mock do proprio main.ts
rem  abre o wizard-mock.db (nao o da escola), monta o aluno ficticio na
rem  primeira vez e sobe na 8420 de sempre.
rem
rem  O que havia aqui antes: copiar o wizard.db, conferir journal, subir
rem  numa segunda porta e chamar um script separado. Tudo isso virou
rem  argumento de linha de comando em 2026-08-25 -- ordem dele, e com
rem  razao: *"tipo assim no terminal e dar um deno run e acabou"*.
rem
rem  Para jogar fora o mock e recomecar:  deno run -A main.ts --mock --novo
rem ===================================================================
cd /d "%~dp0.."
deno run -A main.ts --mock
