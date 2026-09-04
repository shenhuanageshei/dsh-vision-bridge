export function primitiveBoxOrderLabel(visionCapabilities) {
    return visionCapabilities?.boxOrder === 'yxyx'
        ? '[ymin, xmin, ymax, xmax]'
        : '[x1, y1, x2, y2]';
}
export function primitivePromptShape(visionCapabilities) {
    const format = visionCapabilities?.outputFormat || 'hanako';
    if (format === 'gemini') {
        return [
            '  "visual_primitives": [\n    {"id":"v1","type":"box","label":"short label","box_2d":[0,0,0,0],"confidence":0.0}',
            '  ]',
            'For Gemini-family models, use box_2d with the native [ymin, xmin, ymax, xmax] order normalized to 0-1000.',
        ];
    }
    if (format === 'qwen') {
        return [
            '  "visual_primitives": [\n    {"id":"v1","label":"short label","bbox_2d":[0,0,0,0],"point_2d":[0,0],"confidence":0.0}',
            '  ]',
            'For Qwen-family models, use bbox_2d as [x1, y1, x2, y2] and point_2d as [x, y], normalized to 0-1000.',
        ];
    }
    if (format === 'anchor') {
        return [
            '  "visual_anchors": [\n    {"id":"v1","label":"short label","role":"button|text|object|region","center":[0,0],"box":[0,0,0,0],"confidence":0.0}',
            '  ]',
            'For computer-use style models, prefer visual_anchors with center [x, y] for clickable or salient targets, plus box [x1, y1, x2, y2] when visible.',
        ];
    }
    return [
        '  "visual_primitives": [\n    {"id":"v1","type":"box","ref":"short label","box":[0,0,0,0],"confidence":0.0}',
        '  ]',
        `For boxes, output the box array as ${primitiveBoxOrderLabel(visionCapabilities)} normalized to 0-1000.`,
    ];
}
export function buildBasicPrompt(userRequest) {
    const system = [
        'Analyze this image for another text-only model.',
        'Return a concise paper note with these exact sections:',
        'image_overview: fixed basic description of what the image is.',
        'visible_text: important OCR or readable text.',
        'objects_and_layout: important objects, positions, counts, and relationships.',
        'charts_or_data: chart/table/data details if present; otherwise say none.',
        'user_request: restate the user\'s request in one short sentence.',
        'user_request_answer: answer the user\'s request using the image when possible.',
        'evidence: the visual evidence supporting that answer.',
        'uncertainty: anything unclear, hidden, or guessed.',
        'Do not mention that you are a tool or a separate model.',
    ].join('\n');
    const user = `User request:\n${userRequest || '(no explicit text request)'}`;
    return { system, user };
}
export function buildStructuredPrompt(userRequest, visionCapabilities) {
    const shape = primitivePromptShape(visionCapabilities);
    const system = [
        'Analyze this image for another text-only model.',
        'Return only one valid JSON object. Do not wrap it in Markdown.',
        'Use this exact shape:',
        '{',
        '  "image_overview": "fixed basic description of what the image is",',
        '  "visible_text": ["important OCR or readable text"],',
        '  "objects_and_layout": "important objects, positions, counts, and relationships",',
        '  "charts_or_data": "chart/table/data details if present; otherwise none",',
        '  "user_request": "restate the user request in one short sentence",',
        '  "user_request_answer": "answer the user request using the image when possible",',
        '  "evidence": "visual evidence supporting that answer",',
        '  "uncertainty": "anything unclear, hidden, or guessed",',
        ...shape.slice(0, 2),
        '}',
        shape[2],
        visionCapabilities.points
            ? 'You may include point or center coordinates as [x, y] normalized to 0-1000.'
            : 'Do not output point primitives.',
        'Include only coordinates that matter for the user request or key spatial evidence.',
        'Do not mention that you are a tool or a separate model.',
    ].join('\n');
    const user = `User request:\n${userRequest || '(no explicit text request)'}`;
    return { system, user };
}
//# sourceMappingURL=prompts.js.map