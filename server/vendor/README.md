# Vendor: AES-CTR for eBot commands

aes-ctr.js: verbatim copy of eBot-CSGO-Web's web/js/aes.js
(AES-CTR implementation (c) Chris Veness 2005-2012, see the file header;
distributed under the terms of its MIT-style license text at
https://www.movable-type.co.uk/scripts/aes.html — same as the upstream
eBot project ships it). It is the exact algorithm the eBot PHP core
(src/eTools/Utils/Encryption.php) decrypts command messages with, so the
copy must not be replaced by another AES implementation. Run in a vm
sandbox (server/ebot-admin.js loadAes); never load it in a browser page.
