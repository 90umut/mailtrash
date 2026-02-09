import 'dotenv/config'; // Charge les variables du .env dès le début
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Telegraf, Markup } from 'telegraf';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { v4 as uuidv4 } from 'uuid';

const DOMAIN = process.env.DOMAIN;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MY_CHAT_ID = process.env.MY_CHAT_ID;
const PORT_WEB = process.env.WEB_PORT || 3000;
const PORT_SMTP = process.env.SMTP_PORT || 25;

const mailStorage = new Map();

function smartExtract(text) {
    const result = { code: null, link: null };
    
    // Chercher un code à 4-8 chiffres (souvent 6) isolé
    const codeMatch = text.match(/\b\d{4,8}\b/);
    if (codeMatch) result.code = codeMatch[0];

    // Chercher un lien contenant des mots clés magiques
    const urlRegex = /https?:\/\/[^\s$.?#].[^\s]*/g;
    const links = text.match(urlRegex) || [];
    
    // Priorité aux liens de "confirmation" ou "login"
    result.link = links.find(l => /confirm|verify|login|signin|password/i.test(l)) || links[0];

    return result;
}

// --- 2. SERVEUR WEB (Hono) ---
const app = new Hono();

// Route pour voir le mail en entier
app.get('/view/:id', (c) => {
    const id = c.req.param('id');
    const mail = mailStorage.get(id);
    
    if (!mail) return c.text('Ce mail a expiré.', 404);

    return c.html(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: -apple-system, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
                .header { background: #f4f4f5; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
                .meta { color: #666; font-size: 0.9em; }
                .subject { font-size: 1.2em; font-weight: bold; margin-top: 5px; }
            </style>
        </head>
        <body>
            <div class="header">
                <div class="meta">De: ${mail.from}</div>
                <div class="subject">${mail.subject}</div>
            </div>
            <div class="content">${mail.html || `<pre>${mail.text}</pre>`}</div>
        </body>
        </html>
    `);
});

// --- 3. BOT TELEGRAM ---
const bot = new Telegraf(BOT_TOKEN);
bot.start((ctx) => ctx.reply(`Bienvenue. Ton adresse : ${uuidv4().split('-')[0]}@${DOMAIN}`));
bot.launch();

// --- 4. SERVEUR SMTP ---
const server = new SMTPServer({
    authOptional: true, // Accepte tout le monde
    disabledCommands: ['AUTH'], // Pas besoin d'auth
    
    onData(stream, session, callback) {
        simpleParser(stream, async (err, parsed) => {
            if (err) return callback();

            // 1. Stockage RAM
            const mailId = uuidv4();
            mailStorage.set(mailId, {
                from: parsed.from?.text,
                subject: parsed.subject,
                html: parsed.html,
                text: parsed.text
            });
            // Auto-destruction après 15 min
            setTimeout(() => mailStorage.delete(mailId), 15 * 60 * 1000);

            // 2. Extraction Intelligente
            const smartData = smartExtract(parsed.text || "");
            
            // 3. Construction du message Telegram
            let msg = `📧 <b>${parsed.from?.text || 'Inconnu'}</b>\n`;
            msg += `📝 ${parsed.subject}\n\n`;
            
            if (smartData.code) {
                msg += `🔑 CODE : <code>${smartData.code}</code>\n(Clique pour copier)\n\n`;
            }

            // Boutons
            const buttons = [];
            if (smartData.link) {
                buttons.push(Markup.button.url('🔗 Lien détecté', smartData.link));
            }
            // Bouton WebApp (Magique)
            buttons.push(Markup.button.webApp('👀 Voir le mail complet', `https://${DOMAIN}/view/${mailId}`));

            // Envoi
            // NOTE: Pour simplifier, on envoie à ton CHAT_ID fixe. 
            // Sinon il faut gérer une Map session comme vu avant.
            try {
                await bot.telegram.sendMessage(MY_CHAT_ID, msg, {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([buttons])
                });
            } catch (e) {
                console.error("Erreur Telegram:", e);
            }
            
            callback();
        });
    }
});

// Démarrage des serveurs
serve({ fetch: app.fetch, port: PORT_WEB }, () => console.log(`🌍 Web prêt sur le port ${PORT_WEB}`));
server.listen(PORT_SMTP, () => console.log(`📧 SMTP prêt sur le port ${PORT_SMTP}`));
