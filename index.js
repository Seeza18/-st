import { getStringHash, debounce, waitUntilCondition, extractAllWords, isTrueBoolean } from '/scripts/utils.js';
import { getContext, extension_settings, renderExtensionTemplateAsync } from '/scripts/extensions.js';
import {
    activateSendButtons,
    deactivateSendButtons,
    animation_duration,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    generateQuietPrompt,
    is_send_press,
    saveSettingsDebounced,
    substituteParamsExtended,
    generateRaw,
    getMaxPromptTokens,
    setExtensionPrompt,
    streamingProcessor,
    animation_easing,
} from '/script.js';
import { is_group_generating, selected_group } from '/scripts/group-chats.js';
import { loadMovingUIState, power_user } from '/scripts/power-user.js';
import { dragElement } from '/scripts/RossAscends-mods.js';
import { getTextTokens, getTokenCountAsync, tokenizers } from '/scripts/tokenizers.js';
import { debounce_timeout } from '/scripts/constants.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '/scripts/slash-commands/SlashCommandArgument.js';
import { macros, MacroCategory } from '/scripts/macros/macro-system.js';
import { countWebLlmTokens, generateWebLlmChatPrompt, getWebLlmContextSize, isWebLlmSupported, ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { commonEnumProviders } from '/scripts/slash-commands/SlashCommandCommonEnumsProvider.js';
import { removeReasoningFromString } from '/scripts/reasoning.js';
import { MacrosParser } from '/scripts/macros.js';

const MODULE_NAME = '2_custom_summarizer';

let lastMessageHash = null;
let lastMessageId = null;
let inApiCall = false;

async function countSourceTokens(text, padding = 0) {
    if (extension_settings.customSummarizer.source === summary_sources.webllm) {
        const count = await countWebLlmTokens(text);
        return count + padding;
    }
    return await getTokenCountAsync(text, padding);
}

async function getSourceContextSize() {
    const overrideLength = extension_settings.customSummarizer.overrideResponseLength;
    if (extension_settings.customSummarizer.source === summary_sources.webllm) {
        const maxContext = await getWebLlmContextSize();
        return overrideLength > 0 ? (maxContext - overrideLength) : Math.round(maxContext * 0.75);
    }
    return getMaxPromptTokens(overrideLength);
}

function applyOutputLanguage(prompt) {
    if (extension_settings.customSummarizer.outputLanguage === 'english') {
        return prompt + '\n\nIMPORTANT: Write the summary in English only, regardless of the language used in the conversation.';
    }
    return prompt;
}

const formatMemoryValue = function (value) {
    if (!value) return '';
    value = value.trim();
    if (extension_settings.customSummarizer.template) {
        return substituteParamsExtended(extension_settings.customSummarizer.template, { summary: value });
    }
    return `Summary: ${value}`;
};

const saveChatDebounced = debounce(() => getContext().saveChat(), debounce_timeout.relaxed);

const summary_sources = {
    'main': 'main',
    'webllm': 'webllm',
};

const prompt_builders = {
    DEFAULT: 0,
    RAW_BLOCKING: 1,
    RAW_NON_BLOCKING: 2,
};

const defaultPrompt = 'Ignore previous instructions. Summarize the most important facts and events in the story so far. If a summary already exists in your memory, use that as a base and expand with new facts. Limit the summary to {{words}} words or less. Your response should include nothing but the summary.';
const defaultTemplate = '[Summary: {{summary}}]';

const defaultSettings = {
    memoryFrozen: false,
    SkipWIAN: false,
    source: summary_sources.main,
    connectionProfileId: null,
    prompt: defaultPrompt,
    template: defaultTemplate,
    position: extension_prompt_types.IN_PROMPT,
    role: extension_prompt_roles.SYSTEM,
    scan: false,
    depth: 2,
    promptWords: 200,
    promptMinWords: 25,
    promptMaxWords: 1000,
    promptWordsStep: 25,
    promptInterval: 10,
    promptMinInterval: 0,
    promptMaxInterval: 250,
    promptIntervalStep: 1,
    promptForceWords: 0,
    promptForceWordsStep: 100,
    promptMinForceWords: 0,
    promptMaxForceWords: 10000,
    overrideResponseLength: 0,
    overrideResponseLengthMin: 0,
    overrideResponseLengthMax: 4096,
    overrideResponseLengthStep: 16,
    maxMessagesPerRequest: 0,
    maxMessagesPerRequestMin: 0,
    maxMessagesPerRequestMax: 250,
    maxMessagesPerRequestStep: 1,
    prompt_builder: prompt_builders.RAW_BLOCKING,
    outputLanguage: 'jailbreak',
};

function loadSettings() {
    if (!extension_settings.customSummarizer || Object.keys(extension_settings.customSummarizer).length === 0) {
        extension_settings.customSummarizer = {};
        Object.assign(extension_settings.customSummarizer, defaultSettings);
    }

    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings.customSummarizer[key] === undefined) {
            extension_settings.customSummarizer[key] = defaultSettings[key];
        }
    }

    $('#cs_source').val(extension_settings.customSummarizer.source).trigger('change');
    $('#cs_frozen').prop('checked', extension_settings.customSummarizer.memoryFrozen).trigger('input');
    $('#cs_skipWIAN').prop('checked', extension_settings.customSummarizer.SkipWIAN).trigger('input');
    $('#cs_prompt').val(extension_settings.customSummarizer.prompt).trigger('input');
    $('#cs_prompt_words').val(extension_settings.customSummarizer.promptWords).trigger('input');
    $('#cs_prompt_interval').val(extension_settings.customSummarizer.promptInterval).trigger('input');
    $('#cs_template').val(extension_settings.customSummarizer.template).trigger('input');
    $('#cs_depth').val(extension_settings.customSummarizer.depth).trigger('input');
    $('#cs_role').val(extension_settings.customSummarizer.role).trigger('input');
    $(`input[name="cs_position"][value="${extension_settings.customSummarizer.position}"]`).prop('checked', true).trigger('input');
    $('#cs_prompt_words_force').val(extension_settings.customSummarizer.promptForceWords).trigger('input');
    $(`input[name="cs_prompt_builder"][value="${extension_settings.customSummarizer.prompt_builder}"]`).prop('checked', true).trigger('input');
    $('#cs_override_response_length').val(extension_settings.customSummarizer.overrideResponseLength).trigger('input');
    $('#cs_max_messages_per_request').val(extension_settings.customSummarizer.maxMessagesPerRequest).trigger('input');
    $('#cs_include_wi_scan').prop('checked', extension_settings.customSummarizer.scan).trigger('input');
    $('#cs_output_language').val(extension_settings.customSummarizer.outputLanguage);
    switchSourceControls(extension_settings.customSummarizer.source);
}

async function onPromptForceWordsAutoClick() {
    const context = getContext();
    const maxPromptLength = await getSourceContextSize();
    const chat = context.chat;
    const allMessages = chat.filter(m => !m.is_system && m.mes).map(m => m.mes);
    const messagesWordCount = allMessages.map(m => extractAllWords(m)).flat().length;
    const averageMessageWordCount = messagesWordCount / allMessages.length;
    const tokensPerWord = await countSourceTokens(allMessages.join('\n')) / messagesWordCount;
    const wordsPerToken = 1 / tokensPerWord;
    const maxPromptLengthWords = Math.round(maxPromptLength * wordsPerToken);
    const wordsPerPrompt = Math.floor(maxPromptLength / tokensPerWord);
    const summaryPromptWords = extractAllWords(extension_settings.customSummarizer.prompt).length;
    const promptAllowanceWords = maxPromptLengthWords - extension_settings.customSummarizer.promptWords - summaryPromptWords;
    const averageMessagesPerPrompt = Math.floor(promptAllowanceWords / averageMessageWordCount);
    const maxMessagesPerSummary = extension_settings.customSummarizer.maxMessagesPerRequest || 0;
    const targetMessagesInPrompt = maxMessagesPerSummary > 0 ? maxMessagesPerSummary : Math.max(0, averageMessagesPerPrompt);
    const targetSummaryWords = (targetMessagesInPrompt * averageMessageWordCount) + (promptAllowanceWords / 4);

    console.table({ maxPromptLength, maxPromptLengthWords, promptAllowanceWords, averageMessagesPerPrompt, targetMessagesInPrompt, targetSummaryWords, wordsPerPrompt, wordsPerToken, tokensPerWord, messagesWordCount });

    const ROUNDING = 100;
    extension_settings.customSummarizer.promptForceWords = Math.max(1, Math.floor(targetSummaryWords / ROUNDING) * ROUNDING);
    $('#cs_prompt_words_force').val(extension_settings.customSummarizer.promptForceWords).trigger('input');
}

async function onPromptIntervalAutoClick() {
    const context = getContext();
    const maxPromptLength = await getSourceContextSize();
    const chat = context.chat;
    const allMessages = chat.filter(m => !m.is_system && m.mes).map(m => m.mes);
    const messagesWordCount = allMessages.map(m => extractAllWords(m)).flat().length;
    const messagesTokenCount = await countSourceTokens(allMessages.join('\n'));
    const tokensPerWord = messagesTokenCount / messagesWordCount;
    const averageMessageTokenCount = messagesTokenCount / allMessages.length;
    const targetSummaryTokens = Math.round(extension_settings.customSummarizer.promptWords * tokensPerWord);
    const promptTokens = await countSourceTokens(extension_settings.customSummarizer.prompt);
    const promptAllowance = maxPromptLength - promptTokens - targetSummaryTokens;
    const maxMessagesPerSummary = extension_settings.customSummarizer.maxMessagesPerRequest || 0;
    const averageMessagesPerPrompt = Math.floor(promptAllowance / averageMessageTokenCount);
    const targetMessagesInPrompt = maxMessagesPerSummary > 0 ? maxMessagesPerSummary : Math.max(0, averageMessagesPerPrompt);
    const adjustedAverageMessagesPerPrompt = targetMessagesInPrompt + (averageMessagesPerPrompt - targetMessagesInPrompt) / 4;

    console.table({ maxPromptLength, promptAllowance, targetSummaryTokens, promptTokens, messagesWordCount, messagesTokenCount, tokensPerWord, averageMessageTokenCount, averageMessagesPerPrompt, targetMessagesInPrompt, adjustedAverageMessagesPerPrompt, maxMessagesPerSummary });

    const ROUNDING = 5;
    extension_settings.customSummarizer.promptInterval = Math.max(1, Math.floor(adjustedAverageMessagesPerPrompt / ROUNDING) * ROUNDING);
    $('#cs_prompt_interval').val(extension_settings.customSummarizer.promptInterval).trigger('input');
}

function onSummarySourceChange(event) {
    const value = event.target.value;
    extension_settings.customSummarizer.source = value;
    switchSourceControls(value);
    saveSettingsDebounced();
}

function switchSourceControls(value) {
    $('#cs_extensionDrawerContents [data-summary-source], #cs_settings [data-summary-source]').each((_, element) => {
        const source = element.dataset.summarySource.split(',').map(s => s.trim());
        $(element).toggle(source.includes(value));
    });
}

function onMemoryFrozenInput() {
    extension_settings.customSummarizer.memoryFrozen = Boolean($(this).prop('checked'));
    saveSettingsDebounced();
}

function onMemorySkipWIANInput() {
    extension_settings.customSummarizer.SkipWIAN = Boolean($(this).prop('checked'));
    saveSettingsDebounced();
}

function onMemoryPromptWordsInput() {
    extension_settings.customSummarizer.promptWords = Number($(this).val());
    $('#cs_prompt_words_value').text(extension_settings.customSummarizer.promptWords);
    saveSettingsDebounced();
}

function onMemoryPromptIntervalInput() {
    extension_settings.customSummarizer.promptInterval = Number($(this).val());
    $('#cs_prompt_interval_value').text(extension_settings.customSummarizer.promptInterval);
    saveSettingsDebounced();
}

function onMemoryPromptRestoreClick() {
    $('#cs_prompt').val(defaultPrompt).trigger('input');
}

function onMemoryPromptInput() {
    extension_settings.customSummarizer.prompt = $(this).val();
    saveSettingsDebounced();
}

function onMemoryTemplateInput() {
    extension_settings.customSummarizer.template = $(this).val();
    reinsertMemory();
    saveSettingsDebounced();
}

function onMemoryDepthInput() {
    extension_settings.customSummarizer.depth = Number($(this).val());
    reinsertMemory();
    saveSettingsDebounced();
}

function onMemoryRoleInput() {
    extension_settings.customSummarizer.role = Number($(this).val());
    reinsertMemory();
    saveSettingsDebounced();
}

function onMemoryPositionChange(e) {
    extension_settings.customSummarizer.position = e.target.value;
    reinsertMemory();
    saveSettingsDebounced();
}

function onMemoryIncludeWIScanInput() {
    extension_settings.customSummarizer.scan = !!$(this).prop('checked');
    reinsertMemory();
    saveSettingsDebounced();
}

function onMemoryPromptWordsForceInput() {
    extension_settings.customSummarizer.promptForceWords = Number($(this).val());
    $('#cs_prompt_words_force_value').text(extension_settings.customSummarizer.promptForceWords);
    saveSettingsDebounced();
}

function onOverrideResponseLengthInput() {
    extension_settings.customSummarizer.overrideResponseLength = Number($(this).val());
    $('#cs_override_response_length_value').text(extension_settings.customSummarizer.overrideResponseLength);
    saveSettingsDebounced();
}

function onMaxMessagesPerRequestInput() {
    extension_settings.customSummarizer.maxMessagesPerRequest = Number($(this).val());
    $('#cs_max_messages_per_request_value').text(extension_settings.customSummarizer.maxMessagesPerRequest);
    saveSettingsDebounced();
}

function getLatestMemoryFromChat(chat) {
    if (!Array.isArray(chat) || !chat.length) return '';
    const reversedChat = chat.slice().reverse();
    reversedChat.shift();
    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.memory) return mes.extra.memory;
    }
    return '';
}

function getIndexOfLatestChatSummary(chat) {
    if (!Array.isArray(chat) || !chat.length) return -1;
    const reversedChat = chat.slice().reverse();
    reversedChat.shift();
    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.memory) return chat.indexOf(mes);
    }
    return -1;
}

function isContextChanged(context) {
    const newContext = getContext();
    if (newContext.groupId !== context.groupId
        || newContext.chatId !== context.chatId
        || (!newContext.groupId && (newContext.characterId !== context.characterId))) {
        console.log('CS: Context changed, summary discarded');
        return true;
    }
    return false;
}

function onChatChanged() {
    const context = getContext();
    const latestMemory = getLatestMemoryFromChat(context.chat);
    setMemoryContext(latestMemory, false);
}

async function onChatEvent() {
    if (extension_settings.customSummarizer.source === summary_sources.webllm && !isWebLlmSupported()) return;
    if (streamingProcessor && !streamingProcessor.isFinished) return;
    if (inApiCall || extension_settings.customSummarizer.memoryFrozen) return;

    const context = getContext();
    const chat = context.chat;
    if (chat.length === 0) return;

    const lastMessage = chat[chat.length - 1];

    if ((lastMessageId === chat.length && getStringHash(lastMessage.mes) === lastMessageHash)) return;

    if (chat.length < lastMessageId) {
        const latestMemory = getLatestMemoryFromChat(chat);
        setMemoryContext(latestMemory, false);
    }

    if (chat.length
        && lastMessage.extra
        && lastMessage.extra.memory
        && lastMessageId === chat.length
        && getStringHash(lastMessage.mes) !== lastMessageHash) {
        delete lastMessage.extra.memory;
    }

    summarizeChat(context)
        .catch(console.error)
        .finally(() => {
            lastMessageId = context.chat?.length ?? null;
            lastMessageHash = getStringHash((context.chat.length && context.chat[context.chat.length - 1].mes) ?? '');
        });
}

async function forceSummarizeChat(quiet) {
    const context = getContext();
    const skipWIAN = extension_settings.customSummarizer.SkipWIAN;

    const toast = quiet ? jQuery() : toastr.info('Summarizing chat...', 'Please wait', { timeOut: 0, extendedTimeOut: 0 });
    const value = extension_settings.customSummarizer.source === summary_sources.webllm
        ? await summarizeChatWebLLM(context, true)
        : await summarizeChatMain(context, true, skipWIAN);

    toastr.clear(toast);

    if (!value) {
        toastr.warning('Failed to summarize chat');
        return '';
    }

    return value;
}

async function summarizeCallback(args, text) {
    text = text.trim();

    if (!text) {
        const quiet = isTrueBoolean(args.quiet);
        return await forceSummarizeChat(quiet);
    }

    const source = args.source || extension_settings.customSummarizer.source;
    const prompt = applyOutputLanguage(substituteParamsExtended((args.prompt || extension_settings.customSummarizer.prompt), { words: extension_settings.customSummarizer.promptWords }));

    try {
        const profileId = extension_settings.customSummarizer.connectionProfileId;
        if (profileId) {
            const maxTokens = extension_settings.customSummarizer.overrideResponseLength > 0 ? extension_settings.customSummarizer.overrideResponseLength : null;
            const messages = [{ role: 'system', content: prompt }, { role: 'user', content: text }];
            const result = await ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens);
            return removeReasoningFromString(result.content);
        }

        switch (source) {
            case summary_sources.main:
                return removeReasoningFromString(await generateRaw({
                    prompt: text,
                    systemPrompt: prompt,
                    responseLength: extension_settings.customSummarizer.overrideResponseLength || null,
                }));
            case summary_sources.webllm: {
                const messages = [{ role: 'system', content: prompt }, { role: 'user', content: text }].filter(m => m.content);
                const params = extension_settings.customSummarizer.overrideResponseLength > 0 ? { max_tokens: extension_settings.customSummarizer.overrideResponseLength } : {};
                return await generateWebLlmChatPrompt(messages, params);
            }
            default:
                toastr.warning('Invalid summarization source specified');
                return '';
        }
    } catch (error) {
        toastr.error(String(error), 'Failed to summarize text');
        console.error(error);
        return '';
    }
}

async function summarizeChat(context) {
    const skipWIAN = extension_settings.customSummarizer.SkipWIAN;
    switch (extension_settings.customSummarizer.source) {
        case summary_sources.main:
            await summarizeChatMain(context, false, skipWIAN);
            break;
        case summary_sources.webllm:
            await summarizeChatWebLLM(context, false);
            break;
        default:
            break;
    }
}

async function getSummaryPromptForNow(context, force) {
    if (extension_settings.customSummarizer.promptInterval === 0 && !force) {
        console.debug('CS: Prompt interval is set to 0, skipping summarization');
        return '';
    }

    try {
        if (selected_group) {
            await waitUntilCondition(() => is_group_generating === false, 1000, 10);
        }
        await waitUntilCondition(() => is_send_press === false, 30000, 100);
    } catch {
        console.debug('CS: Timeout waiting for is_send_press');
        return '';
    }

    if (!context.chat.length) {
        console.debug('CS: No messages in chat to summarize');
        return '';
    }

    if (context.chat.length < extension_settings.customSummarizer.promptInterval && !force) {
        console.debug(`CS: Not enough messages in chat to summarize (chat: ${context.chat.length}, interval: ${extension_settings.customSummarizer.promptInterval})`);
        return '';
    }

    let messagesSinceLastSummary = 0;
    let wordsSinceLastSummary = 0;
    let conditionSatisfied = false;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        if (context.chat[i].extra && context.chat[i].extra.memory) break;
        messagesSinceLastSummary++;
        wordsSinceLastSummary += extractAllWords(context.chat[i].mes).length;
    }

    if (messagesSinceLastSummary >= extension_settings.customSummarizer.promptInterval) conditionSatisfied = true;
    if (extension_settings.customSummarizer.promptForceWords && wordsSinceLastSummary >= extension_settings.customSummarizer.promptForceWords) conditionSatisfied = true;

    if (!conditionSatisfied && !force) {
        console.debug(`CS: Summary conditions not satisfied (messages: ${messagesSinceLastSummary}, words: ${wordsSinceLastSummary})`);
        return '';
    }

    console.log('CS: Summarizing chat, messages since last summary: ' + messagesSinceLastSummary, 'words since last summary: ' + wordsSinceLastSummary);
    const rawPromptText = substituteParamsExtended(extension_settings.customSummarizer.prompt, { words: extension_settings.customSummarizer.promptWords });

    if (!rawPromptText) {
        console.debug('CS: Summarization prompt is empty. Skipping summarization.');
        return '';
    }

    return applyOutputLanguage(rawPromptText);
}

async function summarizeChatWebLLM(context, force) {
    if (!isWebLlmSupported()) return;

    const prompt = await getSummaryPromptForNow(context, force);
    if (!prompt) return;

    const { rawPrompt, lastUsedIndex } = await getRawSummaryPrompt(context, prompt);

    if (lastUsedIndex === null || lastUsedIndex === -1) {
        if (force) toastr.info('To try again, remove the latest summary.', 'No messages found to summarize');
        return null;
    }

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: rawPrompt },
    ];

    const params = {};
    if (extension_settings.customSummarizer.overrideResponseLength > 0) {
        params.max_tokens = extension_settings.customSummarizer.overrideResponseLength;
    }

    try {
        inApiCall = true;
        const summary = await generateWebLlmChatPrompt(messages, params);
        if (!summary) { console.warn('CS: Empty summary received'); return; }
        if (isContextChanged(context)) return;
        setMemoryContext(summary, true, lastUsedIndex);
        return summary;
    } finally {
        inApiCall = false;
    }
}

async function summarizeChatMain(context, force, skipWIAN) {
    const prompt = await getSummaryPromptForNow(context, force);
    if (!prompt) return;

    console.log('CS: sending summary prompt');
    let summary = '';
    let index = null;

    const profileId = extension_settings.customSummarizer.connectionProfileId;

    // When a Connection Profile is selected, always use raw mode with that profile
    if (profileId) {
        try {
            inApiCall = true;
            deactivateSendButtons();

            const { rawPrompt, lastUsedIndex } = await getRawSummaryPrompt(context, prompt);

            if (lastUsedIndex === null || lastUsedIndex === -1) {
                if (force) toastr.info('To try again, remove the latest summary.', 'No messages found to summarize');
                return null;
            }

            const maxTokens = extension_settings.customSummarizer.overrideResponseLength > 0 ? extension_settings.customSummarizer.overrideResponseLength : null;
            const messages = [
                { role: 'system', content: prompt },
                { role: 'user', content: rawPrompt },
            ];
            const result = await ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens);
            summary = removeReasoningFromString(result.content);
            index = lastUsedIndex;
        } finally {
            inApiCall = false;
            activateSendButtons();
        }
    } else if (prompt_builders.DEFAULT === extension_settings.customSummarizer.prompt_builder) {
        try {
            inApiCall = true;
            const params = {
                quietPrompt: prompt,
                skipWIAN: skipWIAN,
                responseLength: extension_settings.customSummarizer.overrideResponseLength,
            };
            summary = await generateQuietPrompt(params);
        } finally {
            inApiCall = false;
        }
    } else if ([prompt_builders.RAW_BLOCKING, prompt_builders.RAW_NON_BLOCKING].includes(extension_settings.customSummarizer.prompt_builder)) {
        const lock = extension_settings.customSummarizer.prompt_builder === prompt_builders.RAW_BLOCKING;
        try {
            inApiCall = true;
            if (lock) deactivateSendButtons();

            const { rawPrompt, lastUsedIndex } = await getRawSummaryPrompt(context, prompt);

            if (lastUsedIndex === null || lastUsedIndex === -1) {
                if (force) toastr.info('To try again, remove the latest summary.', 'No messages found to summarize');
                return null;
            }

            const params = {
                prompt: rawPrompt,
                systemPrompt: prompt,
                responseLength: extension_settings.customSummarizer.overrideResponseLength || null,
            };
            const rawSummary = await generateRaw(params);
            summary = removeReasoningFromString(rawSummary);
            index = lastUsedIndex;
        } finally {
            inApiCall = false;
            if (lock) activateSendButtons();
        }
    }

    if (!summary) { console.warn('CS: Empty summary received'); return; }
    if (isContextChanged(context)) return;

    setMemoryContext(summary, true, index);
    return summary;
}

async function getRawSummaryPrompt(context, prompt) {
    function getMemoryString(includeSystem) {
        const delimiter = '\n\n';
        const stringBuilder = [];
        const bufferString = chatBuffer.slice().join(delimiter);
        if (includeSystem) stringBuilder.push(prompt);
        if (latestSummary) stringBuilder.push(latestSummary);
        stringBuilder.push(bufferString);
        return stringBuilder.join(delimiter).trim();
    }

    const chat = context.chat.slice();
    const latestSummary = getLatestMemoryFromChat(chat);
    const latestSummaryIndex = getIndexOfLatestChatSummary(chat);
    chat.pop();
    const chatBuffer = [];
    const PADDING = 64;
    const PROMPT_SIZE = await getSourceContextSize();
    let latestUsedMessage = null;

    for (let index = latestSummaryIndex + 1; index < chat.length; index++) {
        const message = chat[index];
        if (!message) break;
        if (message.is_system || !message.mes) continue;

        const entry = `${message.name}:\n${message.mes}`;
        chatBuffer.push(entry);

        const tokens = await countSourceTokens(getMemoryString(true), PADDING);
        if (tokens > PROMPT_SIZE) {
            chatBuffer.pop();
            break;
        }

        latestUsedMessage = message;

        if (extension_settings.customSummarizer.maxMessagesPerRequest > 0 && chatBuffer.length >= extension_settings.customSummarizer.maxMessagesPerRequest) {
            break;
        }
    }

    const lastUsedIndex = context.chat.indexOf(latestUsedMessage);
    const rawPrompt = getMemoryString(false);
    return { rawPrompt, lastUsedIndex };
}

function onMemoryRestoreClick() {
    const context = getContext();
    const content = $('#cs_contents').val();
    const reversedChat = context.chat.slice().reverse();
    reversedChat.shift();

    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.memory == content) {
            delete mes.extra.memory;
            break;
        }
    }

    const newContent = getLatestMemoryFromChat(context.chat);
    setMemoryContext(newContent, false);
}

function onMemoryContentInput() {
    setMemoryContext($(this).val(), true);
}

function onOutputLanguageChange(event) {
    extension_settings.customSummarizer.outputLanguage = event.target.value;
    saveSettingsDebounced();
}

function onMemoryPromptBuilderInput(e) {
    extension_settings.customSummarizer.prompt_builder = Number(e.target.value);
    saveSettingsDebounced();
}

function reinsertMemory() {
    const existingValue = String($('#cs_contents').val());
    setMemoryContext(existingValue, false);
}

function setMemoryContext(value, saveToMessage, index = null) {
    setExtensionPrompt(MODULE_NAME, formatMemoryValue(value), extension_settings.customSummarizer.position, extension_settings.customSummarizer.depth, extension_settings.customSummarizer.scan, extension_settings.customSummarizer.role);
    $('#cs_contents').val(value);

    const summaryLog = value
        ? `CS Summary set to: ${value}. Position: ${extension_settings.customSummarizer.position}. Depth: ${extension_settings.customSummarizer.depth}. Role: ${extension_settings.customSummarizer.role}`
        : 'CS Summary has no content';
    console.debug(summaryLog);

    const context = getContext();
    if (saveToMessage && context.chat.length) {
        const idx = index ?? context.chat.length - 2;
        const mes = context.chat[idx < 0 ? 0 : idx];
        if (!mes.extra) mes.extra = {};
        mes.extra.memory = value;
        saveChatDebounced();
    }
}

function doPopout(e) {
    const target = e.target;
    if ($('#cs_extensionPopout').length === 0) {
        console.debug('CS: creating popout');
        const originalHTMLClone = $(target).parent().parent().parent().find('.inline-drawer-content').html();
        const originalElement = $(target).parent().parent().parent().find('.inline-drawer-content');
        const template = $('#zoomed_avatar_template').html();
        const controlBarHtml = `<div class="panelControlBar flex-container">
        <div id="cs_extensionPopoutheader" class="fa-solid fa-grip drag-grabber hoverglow"></div>
        <div id="cs_extensionPopoutClose" class="fa-solid fa-circle-xmark hoverglow dragClose"></div>
    </div>`;
        const newElement = $(template);
        newElement.attr('id', 'cs_extensionPopout')
            .css('opacity', 0)
            .removeClass('zoomed_avatar')
            .addClass('draggable')
            .empty();
        const prevSummaryBoxContents = $('#cs_contents').val().toString();
        originalElement.empty();
        originalElement.html('<div class="flex-container alignitemscenter justifyCenter wide100p"><small>Currently popped out</small></div>');
        newElement.append(controlBarHtml).append(originalHTMLClone);
        $('#movingDivs').append(newElement);
        newElement.transition({ opacity: 1, duration: animation_duration, easing: animation_easing });
        $('#cs_extensionDrawerContents').addClass('scrollableInnerFull');
        setMemoryContext(prevSummaryBoxContents, false);
        setupListeners();
        loadSettings();
        loadMovingUIState();
        dragElement(newElement);

        $('#cs_extensionPopoutClose').off('click').on('click', function () {
            $('#cs_extensionDrawerContents').removeClass('scrollableInnerFull');
            const summaryPopoutHTML = $('#cs_extensionDrawerContents');
            $('#cs_extensionPopout').fadeOut(animation_duration, () => {
                originalElement.empty();
                originalElement.append(summaryPopoutHTML);
                $('#cs_extensionPopout').remove();
            });
            loadSettings();
        });
    } else {
        console.debug('CS: removing existing popout');
        $('#cs_extensionPopout').fadeOut(animation_duration, () => { $('#cs_extensionPopoutClose').trigger('click'); });
    }
}

function setupListeners() {
    $('#cs_restore').off('click').on('click', onMemoryRestoreClick);
    $('#cs_contents').off('input').on('input', onMemoryContentInput);
    $('#cs_frozen').off('input').on('input', onMemoryFrozenInput);
    $('#cs_skipWIAN').off('input').on('input', onMemorySkipWIANInput);
    $('#cs_source').off('change').on('change', onSummarySourceChange);
    $('#cs_prompt_words').off('input').on('input', onMemoryPromptWordsInput);
    $('#cs_prompt_interval').off('input').on('input', onMemoryPromptIntervalInput);
    $('#cs_prompt').off('input').on('input', onMemoryPromptInput);
    $('#cs_force_summarize').off('click').on('click', () => forceSummarizeChat(false));
    $('#cs_template').off('input').on('input', onMemoryTemplateInput);
    $('#cs_depth').off('input').on('input', onMemoryDepthInput);
    $('#cs_role').off('input').on('input', onMemoryRoleInput);
    $('input[name="cs_position"]').off('change').on('change', onMemoryPositionChange);
    $('#cs_prompt_words_force').off('input').on('input', onMemoryPromptWordsForceInput);
    $('#cs_prompt_builder_default').off('input').on('input', onMemoryPromptBuilderInput);
    $('#cs_prompt_builder_raw_blocking').off('input').on('input', onMemoryPromptBuilderInput);
    $('#cs_prompt_builder_raw_non_blocking').off('input').on('input', onMemoryPromptBuilderInput);
    $('#cs_prompt_restore').off('click').on('click', onMemoryPromptRestoreClick);
    $('#cs_prompt_interval_auto').off('click').on('click', onPromptIntervalAutoClick);
    $('#cs_prompt_words_auto').off('click').on('click', onPromptForceWordsAutoClick);
    $('#cs_override_response_length').off('input').on('input', onOverrideResponseLengthInput);
    $('#cs_max_messages_per_request').off('input').on('input', onMaxMessagesPerRequestInput);
    $('#cs_include_wi_scan').off('input').on('input', onMemoryIncludeWIScanInput);
    $('#cs_output_language').off('change').on('change', onOutputLanguageChange);
    $('#cs_settingsBlockToggle').off('click').on('click', function () {
        $('#cs_settingsBlock').slideToggle(200, 'swing');
    });
}

jQuery(async function () {
    async function addExtensionControls() {
        const settingsHtml = await renderExtensionTemplateAsync('custom-summarizer', 'settings', { defaultSettings });
        $('#summarize_container').append(settingsHtml);
        setupListeners();
        $('#cs_extensionPopoutButton').off('click').on('click', function (e) {
            doPopout(e);
            e.stopPropagation();
        });

        // Initialize Connection Profile dropdown
        try {
            ConnectionManagerRequestService.handleDropdown(
                '#cs_connection_profile',
                extension_settings.customSummarizer?.connectionProfileId ?? null,
                (profile) => {
                    extension_settings.customSummarizer.connectionProfileId = profile?.id ?? null;
                    saveSettingsDebounced();
                },
            );
        } catch (err) {
            console.warn('CS: Connection Manager not available, hiding profile selector.', err);
            $('#cs_connection_profile_block').hide();
        }
    }

    await addExtensionControls();
    loadSettings();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onChatEvent);
    for (const event of [event_types.MESSAGE_DELETED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_SWIPED]) {
        eventSource.on(event, onChatEvent);
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'csummarize',
        callback: summarizeCallback,
        namedArgumentList: [
            new SlashCommandNamedArgument('source', 'API to use for summarization', [ARGUMENT_TYPE.STRING], false, false, '', Object.values(summary_sources)),
            SlashCommandNamedArgument.fromProps({
                name: 'prompt',
                description: 'prompt to use for summarization',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'suppress the toast message when summarizing the chat',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('text to summarize', [ARGUMENT_TYPE.STRING], false, false, ''),
        ],
        helpString: 'Summarizes the given text using Summarize V.2 (supports Connection Profiles for jailbreak). If no text is provided, the current chat will be summarized.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    const summaryMacroHandler = () => {
        const uiSummary = $('#cs_contents').val().toString();
        if (uiSummary.trim().length > 0) return uiSummary;
        return getLatestMemoryFromChat(getContext().chat);
    };

    if (power_user.experimental_macro_engine) {
        try {
            macros.register('cs_summary', {
                category: MacroCategory.CHAT,
                description: 'Returns the latest summary from Summarize V.2.',
                handler: () => summaryMacroHandler(),
            });
        } catch {
            // macro already registered
        }
    } else {
        MacrosParser.registerMacro('cs_summary',
            () => summaryMacroHandler(),
            'Returns the latest summary from Summarize V.2.');
    }
});
