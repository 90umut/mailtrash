import 'dotenv/config'; // Charge les variables du .env
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
const PORT_WEB = process.env.WEB_PORT || 3000;
const PORT_SMTP = process.env.SMTP_PORT || 25;

// Stockage temporaire en RAM (Map)
const mailStorage = new Map();

// --- UTILITAIRES ---

// 1. Nettoyage HTML pour éviter le crash Telegram (Correction de ton erreur)
function escapeHTML(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// 2. Extraction Intelligente (Code & Lien)
function smartExtract(text) {
    const result = { code: null, link: null };
    if (!text) return result;

    // Cherche un code de 4 à 8 chiffres (souvent 6)
    const codeMatch = text.match(/\b\d{4,8}\b/);
    if (codeMatch) result.code = codeMatch[0];

    // Cherche les liens
    const urlRegex = /https?:\/\/[^\s$.?#].[^\s]*/g;
    const links = text.match(urlRegex) || [];
    
    // Cherche un lien "actionnable" (confirm, verify, login...)
    result.link = links.find(l => /confirm|verify|login|signin|password/i.test(l)) || links[0];

    return result;
}

// --- SERVEUR WEB (Hono) ---
const app = new Hono();

app.get('/view/:id', (c) => {
    const id = c.req.param('id');
    const mail = mailStorage.get(id);
    
    if (!mail) return c.html('<h1>Ce mail a expiré ou n\'existe pas.</h1>', 404);

    return c.html(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: -apple-system, sans-serif; padding: 20px; background: #fff; color: #333; }
                .header { background: #f4f4f5; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 5px solid #0088cc; }
                .meta { color: #666; font-size: 0.9em; margin-bottom: 5px; }
                .subject { font-size: 1.2em; font-weight: bold; }
                .content { line-height: 1.6; word-wrap: break-word; }
                img { max-width: 100%; height: auto; }
            </style>
        </head>
        <body>
            <div class="header">
                <div class="meta">De: ${escapeHTML(mail.from)}</div>
                <div class="meta">Pour: ${escapeHTML(mail.to)}</div>
                <div class="subject">${escapeHTML(mail.subject)}</div>
            </div>
            <div class="content">${mail.html || `<pre>${mail.text}</pre>`}</div>
        </body>
        </html>
    `);
});

// --- BOT TELEGRAM ---
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
    ctx.reply(`Bienvenue 👋\nTon domaine est : ${DOMAIN}\nUtilise /new pour générer une adresse.`);
});

bot.command('new', (ctx) => {
    const alias = Math.random().toString(36).substring(2, 10);
    const email = `${alias}@${DOMAIN}`;
    ctx.reply(`📧 Voici ton adresse jetable :\n\n<code>${email}</code>`, { parse_mode: 'HTML' });
});

bot.launch();

// --- SERVEUR SMTP ---
const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['AUTH'], // On accepte tout sans mot de passe
    
    onData(stream, session, callback) {
        simpleParser(stream, async (err, parsed) => {
            if (err) return callback();

            // 1. Sauvegarde RAM (15 min)
            const mailId = uuidv4();
            mailStorage.set(mailId, {
                from: parsed.from?.text || "Inconnu",
                to: parsed.to?.text || "Moi",
                subject: parsed.subject || "(Sans sujet)",
                html: parsed.html,
                text: parsed.text
            });
            setTimeout(() => mailStorage.delete(mailId), 15 * 60 * 1000);

            // 2. Analyse
            const smartData = smartExtract(parsed.text);
            const fromSafe = escapeHTML(parsed.from?.text || "Inconnu");
            const toSafe = escapeHTML(parsed.to?.text || "Moi");
            const subjectSafe = escapeHTML(parsed.subject || "(Sans sujet)");

            // 3. Message Telegram
            let msg = `📧 <b>Nouveau Mail !</b>\n`;
            msg += `👤 <b>De:</b> ${fromSafe}\n`;
            msg += `📥 <b>Pour:</b> ${toSafe}\n`;
            msg += `📝 <b>Sujet:</b> ${subjectSafe}\n\n`;
            
            if (smartData.code) {
                msg += `🔑 <b>CODE DÉTECTÉ :</b>\n<code>${smartData.code}</code>\n(Clique pour copier)\n\n`;
            } else {
                // Aperçu du texte si pas de code
                msg += `<i>${escapeHTML((parsed.text || "").substring(0, 100))}...</i>\n\n`;
            }

            // 4. Boutons
            const buttons = [];
            // Bouton WebApp (pour voir le mail en entier)
            buttons.push([Markup.button.webApp('👀 Voir le mail complet', `https://${DOMAIN}/view/${mailId}`)]);
            
            // Bouton Lien Rapide (si détecté)
            if (smartData.link) {
                buttons.push([Markup.button.url('🔗 Ouvrir le lien de confirmation', smartData.link)]);
            }

            // 5. Envoi
            try {
                await bot.telegram.sendMessage(MY_CHAT_ID, msg, {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: buttons }
                });
            } catch (e) {
                console.error("Erreur Telegram:", e);
            }
            
            callback();
        });
    }
});

// --- DÉMARRAGE ---
// Gestion des erreurs globales
process.on('uncaughtException', (err) => console.error('Crash évité :', err));

serve({ fetch: app.fetch, port: Number(PORT_WEB) }, () => {
    console.log(`🌍 Serveur Web prêt sur le port ${PORT_WEB}`);
});

server.listen(Number(PORT_SMTP), () => {
    console.log(`📧 Serveur SMTP prêt sur le port ${PORT_SMTP}`);
});
