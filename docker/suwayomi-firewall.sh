#!/bin/sh
# Regra de firewall do Suwayomi (docker/docker-compose.suwayomi*.yml): impede o contentor de INICIAR ligacoes aos aparelhos da tua
# rede de casa, ao router e a Tailscale. Deixa-o falar com a internet, com ele proprio, e responder a quem o abre (o ScrollScape e o
# teu browser continuam a chegar a porta 4567).
#
#   sudo sh docker/suwayomi-firewall.sh add      poe as regras
#   sudo sh docker/suwayomi-firewall.sh status   mostra-as
#   sudo sh docker/suwayomi-firewall.sh remove   tira-as
#
# A sub-rede tem de ser a da rede do compose: 172.29.51.0/24 em docker-compose.suwayomi-casaos.yml, 172.29.50.0/24 no outro
# (o do ensaio). Por omissao usa a do CasaOS; para outra:  sudo SUBNET=172.29.50.0/24 sh docker/suwayomi-firewall.sh add
#
# As regras ficam na cadeia DOCKER-USER (a que o Docker deixa para quem quer filtrar o trafego dos contentores). Nao sobrevivem a
# um reinicio do servidor: volta a correr "add" depois de o reiniciares. Se a tua distribuicao nao tiver a cadeia DOCKER-USER,
# o script diz-to e nao faz nada.

SUBNET="${SUBNET:-172.29.51.0/24}"
# Redes privadas, link-local e a gama da Tailscale (CGNAT). A propria sub-rede do contentor esta dentro de 172.16.0.0/12,
# por isso ela e autorizada primeiro (as regras ACCEPT ficam sempre no topo).
BLOCKED="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10"

case "$SUBNET" in
  *[!0-9./]*|"") echo "SUBNET invalida: $SUBNET"; exit 1 ;;
esac
if [ "$(id -u)" -ne 0 ]; then
  echo "Corre com sudo: sudo sh $0 $1"
  exit 1
fi
if ! iptables -n -L DOCKER-USER >/dev/null 2>&1; then
  echo "A cadeia DOCKER-USER nao existe neste servidor (o Docker esta a correr?). Nada foi feito."
  exit 1
fi

case "$1" in
  add)
    for range in $BLOCKED; do
      iptables -C DOCKER-USER -s "$SUBNET" -d "$range" -j DROP 2>/dev/null || iptables -I DOCKER-USER 1 -s "$SUBNET" -d "$range" -j DROP
    done
    iptables -C DOCKER-USER -s "$SUBNET" -d "$SUBNET" -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER 1 -s "$SUBNET" -d "$SUBNET" -j ACCEPT
    # As respostas de uma ligacao que alguem abriu PARA o contentor (o browser, o ScrollScape) saem dele para a rede de casa: sem isto
    # a regra de cima cortava-as e a pagina deixava de abrir.
    iptables -C DOCKER-USER -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER 1 -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    echo "Regras postas:"
    iptables -S DOCKER-USER | grep -- "$SUBNET"
    ;;
  remove)
    for range in $BLOCKED; do
      while iptables -D DOCKER-USER -s "$SUBNET" -d "$range" -j DROP 2>/dev/null; do :; done
    done
    while iptables -D DOCKER-USER -s "$SUBNET" -d "$SUBNET" -j ACCEPT 2>/dev/null; do :; done
    while iptables -D DOCKER-USER -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null; do :; done
    echo "Regras tiradas."
    ;;
  status)
    iptables -S DOCKER-USER | grep -- "$SUBNET" || echo "Nao ha regras para $SUBNET."
    ;;
  *)
    echo "Uso: sudo sh $0 add|remove|status   (SUBNET=... para outra sub-rede)"
    exit 1
    ;;
esac
