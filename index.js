import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Telegraf, Markup } from 'telegraf';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { v4 as uuidv4 } from 'uuid';

// --- CONFIGURATION ---
const DOMAIN = process.env.DOMAIN;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MY_CHAT_ID = process.env.MY_CHAT_ID;
const PORT_WEB = 443;
const PORT_SMTP = 25;

// Chargement des certificats SSL (Vital pour le HTTPS direct)
let sslOptions;
try {
    sslOptions = {
        key: readFileSync(`/etc/letsencrypt/live/${DOMAIN}/privkey.pem`),
        cert: readFileSync(`/etc/letsencrypt/live/${DOMAIN}/fullchain.pem`),
    };
} catch (err) {
    console.error("ERREUR : Impossible de lire les certificats SSL. Vérifie que tu es en SUDO et que le domaine dans .env est correct.");
    process.exit(1);
}

const mailStorage = new Map();

// --- OUTILS DE PARSING ---

function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function smartExtract(text) {
    const result = { code: null, link: null };
    if (!text) return result;

    // Détection de code (4 à 8 chiffres)
    const codeMatch = text.match(/\b\d{4,8}\b/);
    if (codeMatch) result.code = codeMatch[0];

    // Détection de lien de confirmation/connexion
    const urlRegex = /https?:\/\/[^\s$.?#].[^\s]*/g;
    const links = text.match(urlRegex) || [];
    result.link = links.find(l => /confirm|verify|login|signin|password/i.test(l)) || links[0];

    return result;
}

// --- SERVEUR WEB (Hono) ---
const app = new Hono();

app.get('/', (c) => c.html(`
    <body style="font-family:sans-serif; text-align:center; padding:50px;">
        <h1>🚀 Baudelaire.me en HTTPS natif</h1>
        <p>Le serveur est prêt et sécurisé.</p>
    </body>
`));

app.get('/view/:id', (c) => {
    const id = c.req.param('id');
    const mail = mailStorage.get(id);
    if (!mail) return c.html('<b>Mail expiré (limite de 15 minutes).</b>', 404);

    return c.html(`
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: sans-serif; padding: 20px; background: #f4f4f9; }
                .card { background: white; padding: 25px; border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); max-width: 700px; margin: auto; }
                .meta { color: #555; font-size: 0.9em; margin-bottom: 10px; }
                hr { border: 0; border-top: 1px solid #eee; margin: 20px 0; }
                img { max-width: 100%; height: auto; }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="meta"><b>De :</b> ${escapeHTML(mail.from)}</div>
                <div class="meta"><b>Sujet :</b> ${escapeHTML(mail.subject)}</div>
                <hr>
                <div class="content">${mail.html || `<pre>${escapeHTML(mail.text)}</pre>`}</div>
            </div>
        </body>
        </html>
    `);
});

// --- BOT TELEGRAM ---
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => ctx.reply(`Bienvenue sur ton service de mail jetable.\nUtilise n'importe quel préfixe @${DOMAIN}`));

bot.command('new', (ctx) => {
    const alias = Math.random().toString(36).substring(7);
    ctx.reply(`📧 Voici une adresse prête : <code>${alias}@${DOMAIN}</code>`, { parse_mode: 'HTML' });
});

bot.launch();

// --- SERVEUR SMTP ---
const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['AUTH'],
    onData(stream, session, callback) {
        simpleParser(stream, async (err, parsed) => {
            if (err) return callback();

            const mailId = uuidv4();
            mailStorage.set(mailId, {
                from: parsed.from?.text || "Inconnu",
                subject: parsed.subject || "(Sans sujet)",
                html: parsed.html,
                text: parsed.text
            });

            // Auto-suppression après 15 min
            setTimeout(() => mailStorage.delete(mailId), 15 * 60 * 1000);

            const smartData = smartExtract(parsed.text);
            
            // Construction du message Telegram
            let msg = `<b>Nouveau mail reçu !</b>\n\n`;
            msg += `<b>De :</b> ${escapeHTML(parsed.from?.text)}\n`;
            msg += `<b>Sujet :</b> ${escapeHTML(parsed.subject)}\n\n`;

            if (smartData.code) {
                msg += `🔑 <b>CODE DÉTECTÉ :</b> <code>${smartData.code}</code>\n\n`;
            }

            const buttons = [];
            buttons.push(Markup.button.url('Lire le mail complet', `https://${DOMAIN}/view/${mailId}`));
            if (smartData.link) {
                buttons.push(Markup.button.url('Lien direct', smartData.link));
            }

            try {
                await bot.telegram.sendMessage(MY_CHAT_ID, msg, {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard(buttons, { columns: 1 })
                });
            } catch (e) { console.error("Erreur envoi Telegram:", e); }

            callback();
        });
    }
});

// --- LANCEMENT ---

// Serveur Web (Port 443 + SSL)
serve({
    fetch: app.fetch,
    port: PORT_WEB,
    // On ignore le premier argument (info) et on prend le deuxième (handle)
    createServer: (info, handle) => createServer(sslOptions, handle)
}, (info) => {
    console.log(`🌍 Web HTTPS direct prêt sur le port ${PORT_WEB}`);
});

// Serveur SMTP (Port 25)
smtp.listen(PORT_SMTP, () => console.log(`📧 SMTP prêt sur le port ${PORT_SMTP}`));
