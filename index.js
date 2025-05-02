const { Client, LocalAuth } = require("whatsapp-web.js");
const express = require('express');
const qrcode = require("qrcode-terminal");
const xlsx = require("xlsx");
const fs = require("fs");
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;  // A Fly.io fornece a variável PORTT
const { DateTime } = require("luxon");

// --- Carregar contatos autorizados a partir do arquivo de texto ---
let allowedContacts = [];
try {
  const contactsData = fs.readFileSync("allowed.txt", "utf8");
  // Divide o conteúdo em linhas, remove espaços e filtra linhas vazias
  allowedContacts = contactsData
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);
  console.log("Contatos autorizados carregados:");
} catch (err) {
  console.error("Erro ao carregar contatos do arquivo allowed.txt:", err.message);
}

// Criando o cliente do WhatsApp Web
const client = new Client({
    authStrategy: new LocalAuth(), // Salva a autenticação localmente
        puppeteer: {
        headless: true,  // Garantir que o Chrome funcione no modo headless
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox'
            ]
        }
});

let atendimentoHumano = new Set(); // Armazena usuários em atendimento humano
let clientesAtendidos = new Set(); // Garante que a mensagem inicial só seja enviada uma vez por cliente
let usuariosPendentes = new Set(); // Armazena usuários que ainda não escolheram 1 ou 2
let silencedChats = new Set(); // Lista de conversas silenciadas

// Gera o QR Code para autenticação
client.on("qr", (qr) => {
    console.log("Escaneie este QR Code no WhatsApp Web:");
    qrcode.generate(qr, { small: true });
});

// Confirma que o bot foi iniciado
client.on("ready", () => {
    console.log("🤖 Bot conectado e pronto para uso!");
});

// Carrega a planilha
let data = [];
try {
    const workbook = xlsx.readFile("precos.xlsx");
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    data = xlsx.utils.sheet_to_json(sheet);
    console.log("📂 Planilha carregada com sucesso!");
} catch (error) {
    console.error("⚠ Erro ao carregar a planilha:", error.message);
}

// Funções para remover clientes da lista
const removerAtendimentoHumano = (chatId) => {
    setTimeout(async () => {
        if (atendimentoHumano.has(chatId)) {
            atendimentoHumano.delete(chatId);
        }
    }, 60 * 60 * 1000);
};

const removerClientesAtendidos = (chatId) => {
    setTimeout(() => {
        clientesAtendidos.delete(chatId);
    }, 60 * 60 * 1000);
};

const removerSilencedChats = (chatId) => {
    setTimeout(() => {
		silencedChats.delete(chatId);
		clientesAtendidos.delete(chatId);
		console.log(`Chat reativado automaticamente: ${chatId}`);
    }, 30 * 60 * 1000);
};

// Função para buscar preços
const buscarPreco = (produto) => {
    if (!produto) return "⚠ Nenhum produto foi informado. Digite o nome corretamente.";

    // Se a mensagem for apenas "tela", "incell", "original" ou "nacional", retorna erroo
    const termosInvalidos = ["preta", "tela", "incell", "incel", "original", "orig", "nacional", "nac", "com aro"];
    const preposicoes = ["do", "da", "de", "tela", "samsung", "motorola", "display", "combo"];
    const normalizar = (str) =>
        str
            .toLowerCase()
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
            .replace(/\s+/g, ' ') // múltiplos espaços => 1 espaço
            .trim();

    const removerEspacos = (str) => str.replace(/\s+/g, '');

const removerPreposicoes = (str) => {
    return str
        .split(' ')
        .filter(palavra => !preposicoes.includes(palavra))
        .join(' ')
        .trim();
};

    const nomeNormalizado = removerPreposicoes(normalizar(produto));
    const nomeSemEspacos = removerEspacos(nomeNormalizado);

    if (termosInvalidos.includes(nomeNormalizado)) {
        return "❌ Digite o nome completo do produto.";
    }

    const item = data.find(row => {
        if (!row.Produto) return false;

        const nomeProduto = normalizar(row.Produto);
        const nomeProdutoSemEspacos = removerEspacos(nomeProduto);

        return (
            nomeProduto === nomeNormalizado ||
            nomeProdutoSemEspacos === nomeSemEspacos ||
            nomeProduto.includes(nomeNormalizado) ||
            nomeProdutoSemEspacos.includes(nomeSemEspacos)
        );
    });

    if (!item) {
        return "❌ Produto não encontrado.\n\nPara atendimento digite 2️⃣";
	}
	
    return `💰 O preço de *${item.Produto}* é *R$ ${item.Preco}* \n\nPara fazer pedido digite 2️⃣`;
};

const horarioAtendimento = {
    inicio: 9,        // 09:00
    fim: 17,          // 18:00
    minutosFim: 30,   // Até 18:30
    intervaloInicio: 12,   // Início do intervalo de não atendimento (12:00)
    intervaloFim: 12,     // Fim do intervalo de não atendimento (13:00)
};

// Horário de atendimento especial para sabado
const horarioSabado = {
    inicio: 9,        // 09:00
    fim: 17,          // 18:00 (horário reduzido para sabado)
    minutosFim: 0,    // Sem minutos após as 18:00
    intervaloInicio: 12,   // Início do intervalo de não atendimento (12:00)
    intervaloFim: 12,     // Fim do intervalo de não atendimento (13:00)
};

// Função para verificar se está dentro do horário de atendimento
const estaDentroDoHorario = () => {
	const agoraBrasil = DateTime.now().setZone("America/Sao_Paulo");
    const horaAtual = agoraBrasil.hour;
    const minutosAtuais = agoraBrasil.minute;
    const diaSemana = agoraBrasil.weekday; // 1 - Segunda, 2 - Terça, ..., 7 - Domingo

    // Se for Domingo (dia 7)
    if (diaSemana === 7) {
            return false;
        }

    // Se for sabado (dia 6)
    if (diaSemana === 6) {
        // Horário reduzido no sabado (09:00 - 18:00 com intervalo de almoço)
        if (horaAtual >= horarioSabado.inicio && horaAtual < horarioSabado.intervaloInicio) {
            return true; // Entre 09:00 e 12:00
        }

        if (horaAtual >= horarioSabado.intervaloFim && horaAtual < horarioSabado.fim) {
            return true; // Entre 13:00 e 18:00
        }

        return false; // Fora do horário de atendimento ou dentro do intervalo de não atendimento
    }

    // Horário normal de segunda a sexta (09:00 - 18:00 com intervalo de almoço)
    if (horaAtual >= horarioAtendimento.inicio && horaAtual < horarioAtendimento.intervaloInicio) {
        return true; // Entre 09:00 e 12:00
    }

    if (horaAtual >= horarioAtendimento.intervaloFim && horaAtual < horarioAtendimento.fim) {
        return true; // Entre 13:00 e 18:00
    }

    // Verifica se a hora está dentro do intervalo de 18:00 até 18:30
    if (horaAtual === horarioAtendimento.fim && minutosAtuais <= horarioAtendimento.minutosFim) {
        return true; // Entre 18:00 e 18:30
    }

    return false; // Fora do horário de atendimento ou dentro do intervalo de não atendimento
};

// Evento para DETECTAR mensagens enviadas pelo próprio usuário e SILENCIAR a conversa
client.on("message_create", async (message) => {
    const chatId = message.to || message.from;

    // Se a mensagem for enviada por VOCÊ manualmente
    if (message.fromMe) {
        // Lista de palavras-chave usadas em respostas automáticas do bot
        const mensagensDoBot = [
            "📞", "💰", "⏳", "❌", "Olá!", "Digite o nome do produto",
            "Como posso te ajudar?", "Para fazer pedido digite 2️⃣", "Digite a opção", "⚠ Nenhum produto"
        ];

        // Verifica se a mensagem é uma resposta automática do bott
        const ehMensagemDoBot = mensagensDoBot.some(keyword => message.body.includes(keyword));

        if (!ehMensagemDoBot) {
            silencedChats.add(chatId);
            console.log(`Chat silenciado manualmente: ${chatId}`);
			removerSilencedChats(chatId);
        }
    }
});

// Evento de mensagem recebida
client.on("message", async (message) => {
  const chatId = message.from;
  // Extrai o número do remetente, removendo a parte "@c.us"
  const phone = chatId.split("@")[0];
  const msg = message.body.toLowerCase().trim();
  const chat = await message.getChat();
  
      // Se a mensagem contém mídia (foto, vídeo, áudio, documento), o bot ignoraa
    if (message.hasMedia) {
        console.log(`Mensagem com mídia ignorada de ${chatId}`);
        return;
    }
  
      // Se o chat estiver silenciado, ignorar a mensagem
    if (silencedChats.has(chatId)) {
        console.log(`Chat silenciado (${chatId}), ignorando mensagem.`);
        return;
    }

  // Verifica se o remetente está na lista de contatos autorizados
  if (!allowedContacts.includes(phone)) {
    console.log(`Número não autorizado (${phone}). Mensagem ignorada.`);
    return;
  }

    if (msg === "atendimento" || msg === "pedido") {
        if (estaDentroDoHorario()) {
        atendimentoHumano.add(chatId);
        await client.sendMessage(chatId, "📞 Você será atendido em breve. Aguarde...");
		removerAtendimentoHumano(chatId);
        removerClientesAtendidos(chatId);
			const chat = await message.getChat(); // Obtém o chat da mensagem
			if (chat) await chat.markUnread(); // Marca a mensagem como não lida
      } else {
			await client.sendMessage(chatId, "⏳ No momento, não estamos atendendo. Nosso horário de atendimento é de Segunda a Sabado das 9h às 17:30h.\nPor favor, deixe sua mensagem, e retornaremos assim que possível dentro do nosso horário de atendimento.\n\n Agradecemos pela sua compreensão! 😊\n\n Atenciosamente,\n Coutech Cell");
			const chat = await message.getChat(); // Obtém o chat da mensagem
			if (chat) await chat.markUnread(); // Marca a mensagem como não lida
		}
        return;
    }

    if (msg === "consultar valor") {
        atendimentoHumano.delete(chatId);
        await client.sendMessage(chatId, "Digite o nome do produto para consultar o valor.\nExemplos:\n A12 com aro\n G20 sem aro\n k41s com aro\n iPhone 8 plus\n iPhone 12 incell\n iPhone 12 original\n Redmi 12c com aro\n Redmi Note 8 sem aro");
        removerClientesAtendidos(chatId);
			const chat = await message.getChat(); // Obtém o chat da mensagem
			if (chat) await chat.markUnread(); // Marca a mensagem como não lida		
		return;
    }

    // Se o usuário pediu para falar com atendente, o bot não responde mais
    if (atendimentoHumano.has(chatId)) {
        return;
    }
	
	  
  
	if (["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite"].includes(msg)) {
		await client.sendMessage(chatId, "Olá! Como posso te ajudar?\n 1️⃣ - Consultar valor\n 2️⃣ - Atendimento/Pedido");
		usuariosPendentes.add(chatId);
		clientesAtendidos.add(chatId);
		await chat.markUnread();
		return;
	}
	
	if (msg === "1" || msg === "2") {
		clientesAtendidos.add(chatId); // Marca o cliente como atendidooo
	} else {
if (!clientesAtendidos.has(chatId)) {
    const respostaPossivel = buscarPreco(msg);

    // Se buscarPreco retornou algo que não é a mensagem de erro padrão
    if (!respostaPossivel.startsWith("❌ Produto não encontrado") &&
        !respostaPossivel.startsWith("⚠ Nenhum produto")) {
        clientesAtendidos.add(chatId);
        await client.sendMessage(chatId, respostaPossivel);
        await chat.markUnread();
        return;
    }

    // Se não parece uma tentativa de consulta válida, manda mensagem orientandoo
    try {
        await client.sendMessage(
            chatId,
            "Olá! Como posso te ajudar?\n 1️⃣ - Consultar valor\n 2️⃣ - Atendimento/Pedido"
        );
        usuariosPendentes.add(chatId);
        clientesAtendidos.add(chatId);
    } catch (error) {
        if (error.message.includes("Could not get the quoted message")) {
            console.warn("Aviso: Não foi possível obter a mensagem citada. Enviando mensagem mesmo assim.");
        } else {
            console.error("Erro ao enviar mensagem:", error.message);
        }
    }
    return;
}

	}

  // Verifica se o usuário ainda não escolheu 1 ou 2
  if (usuariosPendentes.has(chatId)) {

    if (msg === "1" || msg === "2") {
      usuariosPendentes.delete(chatId); // Remove da lista após escolher
    } else {
      // Laço de repetição continua até que o cliente escolha 1 ou 2
      await client.sendMessage(chatId, "Digite a opção *1️⃣* ou *2️⃣* ");
	  
	          // Obter o chat e marcar a mensagem como não lida
       const chat = await message.getChat(); // Obtém o chat da mensagem
       await chat.markUnread(); // Marca a mensagem como não lida
	  
      return;
    }
  }

		// Lógica para responder às opções "1" e "2"
    if (msg === "2") {
        if (estaDentroDoHorario()) {
        atendimentoHumano.add(chatId);
        await client.sendMessage(chatId, "📞 Você será atendido em breve. Aguarde...");
		removerAtendimentoHumano(chatId);
        removerClientesAtendidos(chatId);
			const chat = await message.getChat(); // Obtém o chat da mensagem
			if (chat) await chat.markUnread(); // Marca a mensagem como não lida		
      } else {
            await client.sendMessage(chatId, "⏳ No momento, não estamos atendendo. Nosso horário de atendimento é de Segunda a Sabado das 9h às 17:30h.\nPor favor, deixe sua mensagem, e retornaremos assim que possível dentro do nosso horário de atendimento.\n\n Agradecemos pela sua compreensão! 😊\n\n Atenciosamente,\n Coutech Cell");
      
			const chat = await message.getChat(); // Obtém o chat da mensagem
			if (chat) await chat.markUnread(); // Marca a mensagem como não lida
	   
		}
        return;
    }

	else if (msg === "1") {
    await client.sendMessage(chatId, "Digite o nome do produto para consultar o valor.\nExemplos:\n A12 com aro\n G20 sem aro\n k41s com aro\n iPhone 8 plus\n iPhone 12 incell\n iPhone 12 original\n Redmi 12c com aro\n Redmi Note 8 sem aro");
		   // Remove o cliente da lista de atendimento após 1 minuto
			removerClientesAtendidos(chatId);
			const chat = await message.getChat(); // Obtém o chat da mensagem
			if (chat) await chat.markUnread(); // Marca a mensagem como não lida	
        return;
}		

    // Consulta de preço pelo nome do produto
    const respostaPreco = buscarPreco(msg);
    await client.sendMessage(chatId, respostaPreco);
	await chat.markUnread();
});

client.initialize();


app.listen(port, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${port}`);
});