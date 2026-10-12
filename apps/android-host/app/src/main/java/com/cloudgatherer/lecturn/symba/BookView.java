package com.cloudgatherer.lecturn.symba;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.drawable.Drawable;
import android.view.View;

final class BookView extends View {
    // Eight 167 ms steps turn a leaf; four more let the official mark settle.
    static final int CYCLE_FRAMES = 12;
    private final Drawable mark;
    private final Paint pagePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path page = new Path();
    private final Path ink = new Path();
    private int frame;
    BookView(Context context) {
        super(context);
        mark = context.getDrawable(R.drawable.lecturn_mark);
        pagePaint.setStrokeCap(Paint.Cap.ROUND);
        pagePaint.setStrokeJoin(Paint.Join.ROUND);
        setContentDescription("Lecturn activity. Tap to expand; drag to move.");
        setFocusable(true);
        setClickable(true);
    }
    void frame(int value) {
        if (value >= 8) value = 0;
        if (frame == value) return;
        frame = value;
        invalidate();
    }
    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        mark.setBounds(0, 0, getWidth(), getHeight());
        mark.draw(canvas);
        if (frame == 0) return;

        float angle = (float) (Math.PI * frame / 8);
        float span = 33f * (float) Math.cos(angle);
        float lift = 4f * (float) Math.sin(angle);
        float edge = 64f + span;
        // A single curved leaf hinges at the original gutter. Everything outside
        // the book stays in the untouched official drawable, including at rest.
        canvas.save();
        canvas.scale(getWidth() / 128f, getHeight() / 128f);
        canvas.clipRect(29f, 44f, 99f, 79f);
        page.rewind();
        page.moveTo(64f, 50f);
        page.cubicTo(64f + span * .35f + lift, 47f - lift * .5f,
                64f + span * .75f + lift, 44f, edge, 46f - lift * .25f);
        page.lineTo(edge, 69f - lift);
        page.cubicTo(64f + span * .75f + lift, 68f - lift,
                64f + span * .35f + lift, 70f - lift, 64f, 75f);
        page.close();
        pagePaint.setStyle(Paint.Style.FILL);
        pagePaint.setColor(frame <= 4 ? Color.rgb(36, 68, 87) : Color.rgb(52, 81, 90));
        canvas.drawPath(page, pagePaint);
        pagePaint.setStyle(Paint.Style.STROKE);
        pagePaint.setColor(Color.rgb(229, 209, 172));
        pagePaint.setStrokeWidth(1.8f);
        canvas.drawPath(page, pagePaint);
        ink.rewind();
        for (int row = 0; row < 2; row++) {
            float y = 55f + row * 6f;
            ink.moveTo(64f + span * .22f + lift * .4f, y - lift * .3f);
            ink.quadTo(64f + span * .5f + lift * .7f, y - 4f - lift * .5f,
                    64f + span * .8f, y - 5f - lift * .5f);
        }
        pagePaint.setColor(Color.rgb(200, 153, 84));
        pagePaint.setStrokeWidth(1.5f);
        canvas.drawPath(ink, pagePaint);
        canvas.restore();
    }
    @Override public boolean performClick() { return super.performClick(); }
}
